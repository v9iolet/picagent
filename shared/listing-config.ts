// These fields travel together from the studio configuration to a listing job.
export const LISTING_CONFIG_FIELDS = ["platform", "targetMarket", "outputLanguage", "sellingPoints"] as const;
export type ListingConfig = Record<(typeof LISTING_CONFIG_FIELDS)[number], string>;

// Request payloads and historical pipeline snapshots have not been validated yet.
export type ListingConfigInput = { [Field in keyof ListingConfig]?: unknown };
