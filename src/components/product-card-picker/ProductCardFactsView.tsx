import {
  PRODUCT_CARD_FIELD_LABELS,
  type ProductCardFields,
} from "../../../shared/product-card";
import { Icon } from "../../pages/shared";
import { useEffect, useState } from "react";

export interface ProductCardFactsViewProps {
  name: string;
  category: string;
  skuCode: string;
  revision?: number;
  coverThumbnailUrl?: string | null;
  snapshotMode?: boolean;
  snapshotAt?: string;
  fields: Partial<ProductCardFields>;
}

export function ProductCardThumb({
  src,
  alt,
  className = "",
}: {
  src?: string | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <div className={`pcp-thumb ${className}`.trim()}>
      {src && !failed ? (
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="pcp-thumb-placeholder" aria-hidden="true">
          <Icon name="box" />
        </span>
      )}
    </div>
  );
}

const REQUIRED_TEXT_ROWS = [
  "specifications",
  "materialsCraft",
  "audienceScenarios",
  "packageContents",
] as const;

const OPTIONAL_TEXT_ROWS = [
  "painPointsComparison",
  "usageDemoHighlights",
  "certificationsProhibitions",
] as const;

export function ProductCardFactsView({
  name,
  category,
  skuCode,
  revision,
  coverThumbnailUrl,
  snapshotMode = false,
  snapshotAt,
  fields,
}: ProductCardFactsViewProps) {
  const sellingPoints = Array.isArray(fields.sellingPoints)
    ? fields.sellingPoints.map((item) => item.trim()).filter(Boolean)
    : [];

  return (
    <div className="pcp-facts">
      <div className="pcp-facts-hero">
        <ProductCardThumb src={coverThumbnailUrl} alt={name} className="is-large" />
        <div className="pcp-facts-hero-info">
          <div className="pcp-badges">
            {skuCode && <span className="pcp-badge is-sku">{skuCode}</span>}
            {category && <span className="pcp-badge is-cat">{category}</span>}
            {revision !== undefined && (
              <span className={`pcp-badge ${snapshotMode ? "is-snapshot" : "is-rev"}`}>
                {snapshotMode ? `快照 v${revision}` : `v${revision}`}
              </span>
            )}
          </div>
          <h4>{name}</h4>
          {snapshotMode && snapshotAt && (
            <small className="pcp-snapshot-time">
              快照冻结于 {new Date(snapshotAt).toLocaleString()}
            </small>
          )}
        </div>
      </div>

      <div className="pcp-facts-group">
        <div className="pcp-facts-group-title">核心商品事实（7 项必填）</div>
        <dl className="pcp-facts-list">
          <div className="pcp-fact-row">
            <dt>{PRODUCT_CARD_FIELD_LABELS.name}</dt>
            <dd>{name || "—"}</dd>
          </div>
          <div className="pcp-fact-row">
            <dt>{PRODUCT_CARD_FIELD_LABELS.category}</dt>
            <dd>{category || "—"}</dd>
          </div>
          <div className="pcp-fact-row">
            <dt>{PRODUCT_CARD_FIELD_LABELS.sellingPoints}</dt>
            <dd>
              {sellingPoints.length > 0 ? (
                <ol className="pcp-selling-points">
                  {sellingPoints.map((point, index) => (
                    <li key={`${index}-${point.slice(0, 12)}`}>{point}</li>
                  ))}
                </ol>
              ) : (
                <span className="pcp-muted">未填写</span>
              )}
            </dd>
          </div>
          {REQUIRED_TEXT_ROWS.map((key) => {
            const value = typeof fields[key] === "string" ? fields[key]!.trim() : "";
            return (
              <div className="pcp-fact-row" key={key}>
                <dt>{PRODUCT_CARD_FIELD_LABELS[key]}</dt>
                <dd>{value || <span className="pcp-muted">未填写</span>}</dd>
              </div>
            );
          })}
        </dl>
      </div>

      <div className="pcp-facts-group">
        <div className="pcp-facts-group-title">扩展商品事实（4 项选填）</div>
        <dl className="pcp-facts-list">
          <div className="pcp-fact-row">
            <dt>{PRODUCT_CARD_FIELD_LABELS.skuCode}</dt>
            <dd>{skuCode || <span className="pcp-muted">未填写</span>}</dd>
          </div>
          {OPTIONAL_TEXT_ROWS.map((key) => {
            const value = typeof fields[key] === "string" ? fields[key]!.trim() : "";
            return (
              <div className="pcp-fact-row" key={key}>
                <dt>{PRODUCT_CARD_FIELD_LABELS[key]}</dt>
                <dd>{value || <span className="pcp-muted">未填写</span>}</dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}
