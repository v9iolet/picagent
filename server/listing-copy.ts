import type { InputImage, LlmModelSnapshot } from "./types.js";

export interface ListingRules {
  titleMaxLength: number;
  maxBulletPoints: number;
  supportsSearchTerms: boolean;
  forbiddenWords: string[];
}
export interface ListingContent {
  schemaVersion: "listing-copy-v1";
  title: string;
  bulletPoints: string[];
  description: string;
  searchTerms?: string[];
  missingFacts: string[];
}
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
  list(limit: number, offset: number): Promise<ListingSummary[]>;
  // Atomically write the job and append versions/image changes only if the revision still matches.
  save(job: ListingJob, previous: ListingJob | null): Promise<boolean>;
  remove(id: string, revision: number): Promise<boolean>;
}
function summary({ versions, inputImages, ...job }: ListingJob): ListingSummary {
  return job;
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
  async list(limit: number, offset: number) {
    return [...this.jobs.values()]
      .filter((j) => j.status !== "draft")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
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
export function validateContent(raw: unknown, rules: ListingRules): ListingContent {
  const c = raw as Partial<ListingContent> | null;
  if (
    !c ||
    c.schemaVersion !== "listing-copy-v1" ||
    typeof c.title !== "string" ||
    typeof c.description !== "string" ||
    !strings(c.bulletPoints) ||
    !strings(c.missingFacts) ||
    (rules.supportsSearchTerms && c.searchTerms !== undefined && !strings(c.searchTerms))
  )
    throw new ListingError("LISTING_INVALID_CONTENT");
  if (Array.from(c.title).length > rules.titleMaxLength) throw new ListingError("LISTING_TITLE_TOO_LONG");
  if (c.bulletPoints.length > rules.maxBulletPoints) throw new ListingError("LISTING_TOO_MANY_BULLETS");
  const searchTerms = rules.supportsSearchTerms ? (c.searchTerms ?? []) : [];
  const fields = [c.title, ...c.bulletPoints, c.description, ...searchTerms].map((s) => s.normalize("NFKC").toLowerCase());
  if (rules.forbiddenWords.some((w) => w && fields.some((f) => f.includes(w.normalize("NFKC").toLowerCase()))))
    throw new ListingError("LISTING_FORBIDDEN_WORD");
  return {
    schemaVersion: c.schemaVersion,
    title: c.title,
    bulletPoints: c.bulletPoints,
    description: c.description,
    ...(rules.supportsSearchTerms ? { searchTerms } : {}),
    missingFacts: c.missingFacts,
  };
}
