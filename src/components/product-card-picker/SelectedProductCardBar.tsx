import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { productCardsApi, type ApiProductCard } from "../../api/client";
import { Icon } from "../../pages/shared";
import { ProductCardFactsView, ProductCardThumb } from "./ProductCardFactsView";
import {
  hasFullProductCardFacts,
  toSelectedProductCardSummary,
  type SelectedProductCardSummary,
} from "./types";
import "./product-card-picker.css";

export interface SelectedProductCardBarProps {
  card: SelectedProductCardSummary;
  readOnly?: boolean;
  disabled?: boolean;
  compact?: boolean;
  onChangeCard?: () => void;
  onRemove?: () => void;
}

export function SelectedProductCardBar({
  card,
  readOnly = false,
  disabled = false,
  compact = false,
  onChangeCard,
  onRemove,
}: SelectedProductCardBarProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [loadedCard, setLoadedCard] = useState<ApiProductCard | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");
  const detailSeqRef = useRef(0);

  useEffect(() => {
    setLoadedCard(null);
    setDetailError("");
  }, [card.cardId, card.revision, readOnly]);

  useEffect(() => {
    if (!detailOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailOpen]);

  useEffect(() => {
    if (!detailOpen || readOnly || hasFullProductCardFacts(card) || loadedCard?.id === card.cardId) {
      return;
    }
    let active = true;
    const seq = ++detailSeqRef.current;
    setLoadingDetail(true);
    setDetailError("");
    void productCardsApi
      .get(card.cardId)
      .then((detail) => {
        if (!active || seq !== detailSeqRef.current) return;
        setLoadedCard(detail);
      })
      .catch((error) => {
        if (!active || seq !== detailSeqRef.current) return;
        setDetailError(error instanceof Error ? error.message : "商品信息卡详情加载失败");
      })
      .finally(() => {
        if (active && seq === detailSeqRef.current) setLoadingDetail(false);
      });
    return () => {
      active = false;
    };
  }, [detailOpen, readOnly, card, loadedCard]);

  const detailData =
    !readOnly && loadedCard && loadedCard.id === card.cardId
      ? toSelectedProductCardSummary(loadedCard)
      : card;

  const detailModal = detailOpen
    ? createPortal(
        <div
          className="pcp-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDetailOpen(false);
          }}
        >
          <section
            className="pcp-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label={readOnly ? "商品信息卡快照详情" : "商品信息卡详情"}
            data-product-card-detail-dialog
          >
            <header className="pcp-modal-head">
              <div>
                <span className="pcp-eyebrow">
                  {readOnly ? "PRODUCT CARD SNAPSHOT" : "PRODUCT CARD"}
                </span>
                <h3>{readOnly ? "历史批次商品信息卡快照" : "已选商品信息卡详情"}</h3>
                <small>
                  {readOnly
                    ? "该批次提交时已冻结商品卡事实快照，不受后续商品库编辑、归档或删除影响。"
                    : "客观商品事实将在生成时自动注入；供应商参考图仅用于认款展示，不进入生图原图区。"}
                </small>
              </div>
              <button
                type="button"
                className="pcp-close-btn"
                aria-label="关闭商品信息卡详情"
                onClick={() => setDetailOpen(false)}
              >
                <Icon name="x" />
              </button>
            </header>

            <div className="pcp-detail-body">
              {loadingDetail ? (
                <p className="pcp-state" role="status">
                  正在加载商品信息卡完整事实…
                </p>
              ) : detailError ? (
                <p className="pcp-state is-error" role="alert">
                  {detailError}
                </p>
              ) : (
                <ProductCardFactsView
                  name={detailData.name}
                  category={detailData.category}
                  skuCode={detailData.skuCode}
                  revision={detailData.revision}
                  coverThumbnailUrl={detailData.coverThumbnailUrl}
                  snapshotMode={readOnly}
                  snapshotAt={detailData.snapshotAt}
                  fields={detailData}
                />
              )}
            </div>

            <footer className="pcp-modal-foot">
              <button type="button" className="pcp-btn" onClick={() => setDetailOpen(false)}>
                关闭
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <div
        className={`pcp-selected-bar${readOnly ? " is-readonly" : ""}${compact ? " is-compact" : ""}`}
        data-selected-product-card-bar
        data-card-id={card.cardId}
        data-readonly={readOnly ? "true" : "false"}
      >
        <ProductCardThumb
          src={card.coverThumbnailUrl}
          alt={card.name}
          className={compact ? "is-small" : ""}
        />
        <div className="pcp-selected-info">
          <div className="pcp-selected-name-row">
            <strong title={card.name}>{card.name}</strong>
            {readOnly && (
              <span className="pcp-badge is-snapshot" data-snapshot-revision={card.revision}>
                快照 v{card.revision}
              </span>
            )}
          </div>
          <div className="pcp-badges">
            {card.skuCode && <span className="pcp-badge is-sku">{card.skuCode}</span>}
            {card.category && <span className="pcp-badge is-cat">{card.category}</span>}
          </div>
        </div>
        <div className="pcp-selected-actions">
          <button
            type="button"
            className="pcp-action-btn"
            onClick={() => setDetailOpen(true)}
          >
            查看详情
          </button>
          {!readOnly && onChangeCard && (
            <button
              type="button"
              className="pcp-action-btn"
              disabled={disabled}
              onClick={onChangeCard}
            >
              更换
            </button>
          )}
          {!readOnly && onRemove && (
            <button
              type="button"
              className="pcp-action-btn is-danger"
              disabled={disabled}
              onClick={onRemove}
            >
              移除
            </button>
          )}
        </div>
      </div>
      {detailModal}
    </>
  );
}
