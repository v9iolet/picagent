import { listingFieldEnabled, type ListingContent, type ListingRules } from "../shared/listing-config.js";
import type { InputImage, LlmModelSnapshot } from "./types.js";

export type { ListingContent, ListingRules } from "../shared/listing-config.js";
export type ListingImage = Pick<
  InputImage,
  | "id"
  | "ordinal"
  | "originalObjectKey"
  | "thumbnailObjectKey"
  | "mimeType"
  | "width"
  | "height"
  | "sha256"
  | "originalFilename"
>;
export interface ListingVersion {
  id: string;
  versionNumber: number;
  content: ListingContent;
  createdAt: string;
  promptSnapshot: {
    templateVersionId: string;
    templateCode: string;
    templateVersionNo: number;
    input: Record<string, unknown>;
    model: LlmModelSnapshot;
    editedFromVersionId?: string;
  };
}
export interface ListingSummary {
  id: string;
  sourceSuiteId: string | null;
  platform: string;
  targetMarket: string;
  outputLanguage: string;
  input: { sellingPoints: string };
  status: "draft" | "running" | "succeeded" | "failed";
  errorCode: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ListingJob extends ListingSummary {
  inputImages: ListingImage[];
  versions: ListingVersion[];
}
export interface ListingRepository {
  get(id: string): Promise<ListingJob | null>;
  summary(id: string): Promise<ListingSummary | null>;
  findLatestBySuiteId(suiteId: string): Promise<ListingSummary | null>;
  list(limit: number, offset: number): Promise<ListingSummary[]>;
  // Atomically write the job and append versions/image changes only if the revision still matches.
  save(job: ListingJob, previous: ListingJob | null): Promise<boolean>;
  remove(id: string, revision: number): Promise<boolean>;
}
function summary({ versions, inputImages, ...job }: ListingJob): ListingSummary {
  return job;
}
function newestFirst(a: ListingJob, b: ListingJob) {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}
export class MemoryListingRepository implements ListingRepository {
  private jobs = new Map<string, ListingJob>();
  async get(id: string) {
    return structuredClone(this.jobs.get(id) ?? null);
  }
  async summary(id: string) {
    const j = this.jobs.get(id);
    return j ? structuredClone(summary(j)) : null;
  }
  async findLatestBySuiteId(suiteId: string) {
    const [latest] = [...this.jobs.values()]
      .filter((job) => job.sourceSuiteId === suiteId && job.status !== "draft")
      .sort(newestFirst);
    return latest ? structuredClone(summary(latest)) : null;
  }
  async list(limit: number, offset: number) {
    return [...this.jobs.values()]
      .filter((j) => j.status !== "draft")
      .sort(newestFirst)
      .slice(offset, offset + limit)
      .map((j) => structuredClone(summary(j)));
  }
  async save(job: ListingJob, previous: ListingJob | null) {
    if (this.jobs.get(job.id)?.revision !== previous?.revision) return false;
    this.jobs.set(job.id, structuredClone(job));
    return true;
  }
  async remove(id: string, revision: number) {
    return this.jobs.get(id)?.revision === revision && this.jobs.delete(id);
  }
}
export class ListingError extends Error {
  constructor(
    code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const requiredText = ["title", "description"] as const;
const requiredLists = ["bulletPoints", "missingFacts"] as const;
const optionalText = ["itemHighlights", "seoTitle", "seoDescription", "subtitle"] as const;
const optionalLists = ["searchTerms", "tags", "hashtags"] as const;
const fieldNames = new Set<string>(["schemaVersion", ...requiredText, ...requiredLists, ...optionalText, ...optionalLists]);
const normalized = (text: string) => text.normalize("NFKC").toLowerCase();

export function validateContent(raw: unknown, rules: ListingRules): ListingContent {
  const c = raw as ListingContent;
  if (
    !c || typeof c !== "object" || Array.isArray(c) ||
    c.schemaVersion !== "listing-copy-v1" ||
    Object.keys(c).some((key) => !fieldNames.has(key)) ||
    requiredText.some((field) => typeof c[field] !== "string") ||
    requiredLists.some((field) => !strings(c[field])) ||
    optionalText.some((field) => c[field] !== undefined && typeof c[field] !== "string") ||
    optionalLists.some((field) => c[field] !== undefined && !strings(c[field]))
  )
    throw new ListingError("LISTING_INVALID_CONTENT");
  const fields = [...requiredText, ...requiredLists, ...optionalText, ...optionalLists]
    .flatMap((field) => c[field] ?? [])
    .map(normalized);
  if (rules.forbiddenWords.some((word) => word && fields.some((field) => field.includes(normalized(word)))))
    throw new ListingError("LISTING_FORBIDDEN_WORD");
  const content = { ...c };
  for (const field of [...optionalText, ...optionalLists]) {
    if (!listingFieldEnabled(field, rules)) delete content[field];
  }
  return content;
}
