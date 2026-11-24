import type {
  ProductCard,
  ProductCardSnapshot,
  ProductCardSummary,
} from "../../../shared/product-card";

export interface SelectedProductCardSummary {
  cardId: string;
  name: string;
  category: string;
  skuCode: string;
  revision: number;
  coverThumbnailUrl: string | null;
  sellingPoints?: string[];
  specifications?: string;
  materialsCraft?: string;
  audienceScenarios?: string;
  packageContents?: string;
  painPointsComparison?: string;
  usageDemoHighlights?: string;
  certificationsProhibitions?: string;
  snapshotAt?: string;
}

export function isProductCardSnapshot(
  value: ProductCard | ProductCardSnapshot | ProductCardSummary | SelectedProductCardSummary,
): value is ProductCardSnapshot {
  return "cardId" in value && "snapshotAt" in value && typeof value.snapshotAt === "string";
}

export function toSelectedProductCardSummary(
  card: ProductCard | ProductCardSnapshot,
): SelectedProductCardSummary {
  const cardId = "cardId" in card ? card.cardId : card.id;
  return {
    cardId,
    name: card.name,
    category: card.category,
    skuCode: card.skuCode,
    revision: card.revision,
    coverThumbnailUrl: card.coverThumbnailUrl ?? null,
    sellingPoints: [...card.sellingPoints],
    specifications: card.specifications,
    materialsCraft: card.materialsCraft,
    audienceScenarios: card.audienceScenarios,
    packageContents: card.packageContents,
    painPointsComparison: card.painPointsComparison,
    usageDemoHighlights: card.usageDemoHighlights,
    certificationsProhibitions: card.certificationsProhibitions,
    ...("snapshotAt" in card && card.snapshotAt ? { snapshotAt: card.snapshotAt } : {}),
  };
}

export function hasFullProductCardFacts(card: SelectedProductCardSummary): boolean {
  return (
    Array.isArray(card.sellingPoints) &&
    typeof card.specifications === "string" &&
    typeof card.materialsCraft === "string" &&
    typeof card.audienceScenarios === "string" &&
    typeof card.packageContents === "string"
  );
}

export function sanitizeSelectedProductCardSummary(
  raw: unknown,
): SelectedProductCardSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const cardId = typeof row.cardId === "string" ? row.cardId.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!cardId || !name) return null;
  const revision =
    typeof row.revision === "number" && Number.isFinite(row.revision) && row.revision >= 1
      ? Math.trunc(row.revision)
      : 1;
  return {
    cardId,
    name,
    category: typeof row.category === "string" ? row.category : "",
    skuCode: typeof row.skuCode === "string" ? row.skuCode : "",
    revision,
    coverThumbnailUrl:
      typeof row.coverThumbnailUrl === "string" && row.coverThumbnailUrl.trim()
        ? row.coverThumbnailUrl.trim()
        : null,
    ...(Array.isArray(row.sellingPoints)
      ? {
          sellingPoints: row.sellingPoints.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : {}),
    ...(typeof row.specifications === "string" ? { specifications: row.specifications } : {}),
    ...(typeof row.materialsCraft === "string" ? { materialsCraft: row.materialsCraft } : {}),
    ...(typeof row.audienceScenarios === "string"
      ? { audienceScenarios: row.audienceScenarios }
      : {}),
    ...(typeof row.packageContents === "string" ? { packageContents: row.packageContents } : {}),
    ...(typeof row.painPointsComparison === "string"
      ? { painPointsComparison: row.painPointsComparison }
      : {}),
    ...(typeof row.usageDemoHighlights === "string"
      ? { usageDemoHighlights: row.usageDemoHighlights }
      : {}),
    ...(typeof row.certificationsProhibitions === "string"
      ? { certificationsProhibitions: row.certificationsProhibitions }
      : {}),
    ...(typeof row.snapshotAt === "string" && row.snapshotAt
      ? { snapshotAt: row.snapshotAt }
      : {}),
  };
}
