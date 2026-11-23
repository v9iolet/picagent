// These fields travel together from the studio configuration to a listing job.
export const LISTING_CONFIG_FIELDS = ["platform", "targetMarket", "outputLanguage", "sellingPoints"] as const;
export type ListingConfig = Record<(typeof LISTING_CONFIG_FIELDS)[number], string>;

// Request payloads and historical pipeline snapshots have not been validated yet.
export type ListingConfigInput = { [Field in keyof ListingConfig]?: unknown };

export interface ListingRules {
  titleMaxLength: number;
  maxBulletPoints: number;
  supportsSearchTerms: boolean;
  forbiddenWords: string[];
  itemHighlightsMaxLength?: number;
  searchTermsMaxBytes?: number;
  maxTags?: number;
  tagMaxLength?: number;
  seoTitleMaxLength?: number;
  seoDescriptionMaxLength?: number;
  subtitleMaxLength?: number;
  maxHashtags?: number;
}

export interface ListingContent {
  schemaVersion: "listing-copy-v1";
  title: string;
  bulletPoints: string[];
  description: string;
  missingFacts: string[];
  searchTerms?: string[];
  itemHighlights?: string;
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
  subtitle?: string;
  hashtags?: string[];
}

const optionalFieldRules = {
  itemHighlights: "itemHighlightsMaxLength",
  searchTerms: "supportsSearchTerms",
  tags: "maxTags",
  seoTitle: "seoTitleMaxLength",
  seoDescription: "seoDescriptionMaxLength",
  subtitle: "subtitleMaxLength",
  hashtags: "maxHashtags",
} as const;
type OptionalField = keyof typeof optionalFieldRules;

export function listingFieldEnabled(field: OptionalField, rules?: ListingRules) {
  const limit = rules?.[optionalFieldRules[field]];
  return limit === true || typeof limit === "number";
}

export interface ListingCount {
  field: OptionalField | "title" | "bulletPoints";
  actual: number;
  limit: number;
  unit: "characters" | "bytes" | "items";
  itemIndex?: number;
}

const characters = (text?: string) => Array.from(text ?? "").length;

export function listingFieldCounts(content: ListingContent, rules?: ListingRules): ListingCount[] {
  if (!rules) return [];
  const counts: ListingCount[] = [];
  function add(field: ListingCount["field"], actual: number, limit: number | undefined, unit: ListingCount["unit"]) {
    if (limit !== undefined) counts.push({ field, actual, limit, unit });
  }
  add("title", characters(content.title), rules.titleMaxLength, "characters");
  add("bulletPoints", content.bulletPoints.length, rules.maxBulletPoints, "items");
  add("itemHighlights", characters(content.itemHighlights), rules.itemHighlightsMaxLength, "characters");
  if (rules.supportsSearchTerms && rules.searchTermsMaxBytes !== undefined) {
    const bytes = new TextEncoder().encode((content.searchTerms ?? []).join(" ")).length;
    add("searchTerms", bytes, rules.searchTermsMaxBytes, "bytes");
  }
  if (rules.maxTags !== undefined) {
    const tags = content.tags ?? [];
    add("tags", tags.length, rules.maxTags, "items");
    const limit = rules.tagMaxLength;
    if (limit !== undefined) {
      tags.forEach((tag, itemIndex) => counts.push({
        field: "tags", actual: characters(tag), limit, unit: "characters", itemIndex,
      }));
    }
  }
  add("seoTitle", characters(content.seoTitle), rules.seoTitleMaxLength, "characters");
  add("seoDescription", characters(content.seoDescription), rules.seoDescriptionMaxLength, "characters");
  add("subtitle", characters(content.subtitle), rules.subtitleMaxLength, "characters");
  add("hashtags", content.hashtags?.length ?? 0, rules.maxHashtags, "items");
  return counts;
}

export function evaluateListingWarnings(content: ListingContent, rules?: ListingRules): ListingCount[] {
  return listingFieldCounts(content, rules).filter(({ actual, limit }) => actual > limit);
}
