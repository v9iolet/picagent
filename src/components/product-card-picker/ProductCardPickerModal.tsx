import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  productCardsApi,
  type ApiProductCard,
  type ApiProductCardSummary,
} from "../../api/client";
import { Icon } from "../../pages/shared";
import { ProductCardFactsView, ProductCardThumb } from "./ProductCardFactsView";
import "./product-card-picker.css";

const PICKER_PAGE_SIZE = 10;

export interface ProductCardPickerModalProps {
  open: boolean;
  selectedCardId?: string | null;
  onClose: () => void;
  onConfirm: (card: ApiProductCard) => void;
  title?: string;
}

export function ProductCardPickerModal({
  open,
  selectedCardId = null,
  onClose,
  onConfirm,
  title = "选择商品信息卡",
}: ProductCardPickerModalProps) {
  const [keywordInput, setKeywordInput] = useState("");
  const [activeKeyword, setActiveKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ApiProductCardSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState("");

  const [highlightedId, setHighlightedId] = useState<string | null>(selectedCardId ?? null);
  const [previewCard, setPreviewCard] = useState<ApiProductCard | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");

  const listSeqRef = useRef(0);
  const detailSeqRef = useRef(0);
  const detailCacheRef = useRef<Map<string, ApiProductCard>>(new Map());

  // Reset state whenever modal opens
  useEffect(() => {
    if (!open) return;
    setKeywordInput("");
    setActiveKeyword("");
    setPage(1);
    setListError("");
    setDetailError("");
    setHighlightedId(selectedCardId ?? null);
    setPreviewCard(null);
    detailCacheRef.current.clear();
  }, [open, selectedCardId]);

  // Debounce keyword input
  useEffect(() => {
    if (!open) return;
    const trimmed = keywordInput.trim();
    if (trimmed === activeKeyword) return;
    const timer = window.setTimeout(() => {
      setActiveKeyword(trimmed);
      setPage(1);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, keywordInput, activeKeyword]);

  // Fetch published product cards
  useEffect(() => {
    if (!open) return;
    let active = true;
    const seq = ++listSeqRef.current;
    setLoadingList(true);
    setListError("");
    void productCardsApi
      .list({
        status: "published",
        keyword: activeKeyword || undefined,
        limit: PICKER_PAGE_SIZE,
        offset: (page - 1) * PICKER_PAGE_SIZE,
      })
      .then((result) => {
        if (!active || seq !== listSeqRef.current) return;
        const publishedOnly = result.items.filter((item) => item.status === "published");
        setItems(publishedOnly);
        setTotal(result.total);
        setHighlightedId((current) => {
          if (current && publishedOnly.some((item) => item.id === current)) return current;
          if (selectedCardId && publishedOnly.some((item) => item.id === selectedCardId)) {
            return selectedCardId;
          }
          return publishedOnly[0]?.id ?? null;
        });
      })
      .catch((error) => {
        if (!active || seq !== listSeqRef.current) return;
        setListError(error instanceof Error ? error.message : "商品信息卡加载失败，请重试");
      })
      .finally(() => {
        if (active && seq === listSeqRef.current) setLoadingList(false);
      });
    return () => {
      active = false;
    };
  }, [open, activeKeyword, page, selectedCardId]);

  // Fetch full 6+3 facts for highlighted card
  useEffect(() => {
    if (!open) return;
    if (!highlightedId) {
      setPreviewCard(null);
      setLoadingDetail(false);
      setDetailError("");
      return;
    }
    const cached = detailCacheRef.current.get(highlightedId);
    if (cached) {
      setPreviewCard(cached);
      setLoadingDetail(false);
      setDetailError("");
      return;
    }
    let active = true;
    const seq = ++detailSeqRef.current;
    setLoadingDetail(true);
    setDetailError("");
    void productCardsApi
      .get(highlightedId)
      .then((detail) => {
        if (!active || seq !== detailSeqRef.current) return;
        if (detail.status !== "published") {
          setPreviewCard(null);
          setDetailError("该商品信息卡已归档，无法绑定到新建批次。");
          return;
        }
        detailCacheRef.current.set(detail.id, detail);
        setPreviewCard(detail);
      })
      .catch((error) => {
        if (!active || seq !== detailSeqRef.current) return;
        setPreviewCard(null);
        setDetailError(error instanceof Error ? error.message : "商品卡详情加载失败");
      })
      .finally(() => {
        if (active && seq === detailSeqRef.current) setLoadingDetail(false);
      });
    return () => {
      active = false;
    };
  }, [open, highlightedId]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const totalPages = Math.max(1, Math.ceil(total / PICKER_PAGE_SIZE));
  const canConfirm = Boolean(previewCard && previewCard.id === highlightedId && !loadingDetail);

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = keywordInput.trim();
    setActiveKeyword(trimmed);
    setPage(1);
  };

  return createPortal(
    <div
      className="pcp-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="pcp-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-product-card-picker-modal
      >
        <header className="pcp-modal-head">
          <div>
            <span className="pcp-eyebrow">PRODUCT CARD LIBRARY</span>
            <h3>{title}</h3>
            <small>仅展示在用（published）商品信息卡，单批次最多绑定 1 张；供应商参考图不流入生图原图区。</small>
          </div>
          <button
            type="button"
            className="pcp-close-btn"
            aria-label="关闭商品信息卡选择器"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>

        <form className="pcp-search-bar" onSubmit={handleSearchSubmit}>
          <div className="pcp-search-input-wrap">
            <Icon name="search" />
            <input
              type="search"
              aria-label="搜索商品信息卡"
              placeholder="搜索商品名称或核心卖点"
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              autoFocus
            />
            {keywordInput && (
              <button
                type="button"
                className="pcp-search-clear"
                aria-label="清空搜索"
                onClick={() => {
                  setKeywordInput("");
                  setActiveKeyword("");
                  setPage(1);
                }}
              >
                ×
              </button>
            )}
          </div>
          <button type="submit" className="pcp-btn">
            搜索
          </button>
        </form>

        <div className="pcp-picker-body">
          <div className="pcp-list-col" aria-label="在用商品信息卡列表">
            {listError ? (
              <p className="pcp-state is-error" role="alert">
                {listError}
              </p>
            ) : loadingList && items.length === 0 ? (
              <p className="pcp-state" role="status">
                正在加载商品信息卡…
              </p>
            ) : items.length === 0 ? (
              <div className="pcp-empty">
                <Icon name="box" />
                <strong>{activeKeyword ? "未找到匹配的在用商品卡" : "暂无在用商品信息卡"}</strong>
                <small>
                  {activeKeyword
                    ? "请尝试更换商品名称或核心卖点关键词。"
                    : "可先在「首页」建档或在「商品库」手动新建商品卡。"}
                </small>
              </div>
            ) : (
              <ul className="pcp-card-list">
                {items.map((item) => {
                  const isActive = item.id === highlightedId;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`pcp-card-option${isActive ? " is-selected" : ""}`}
                        aria-pressed={isActive}
                        data-picker-card-id={item.id}
                        onClick={() => setHighlightedId(item.id)}
                      >
                        <ProductCardThumb
                          src={item.coverThumbnailUrl}
                          alt={item.name}
                          className="is-small"
                        />
                        <div className="pcp-card-option-info">
                          <strong title={item.name}>{item.name}</strong>
                          {item.sellingPoints[0] && (
                            <span className="pcp-muted" title={item.sellingPoints[0]}>
                              {item.sellingPoints[0]}
                            </span>
                          )}
                        </div>
                        <span className="pcp-check-mark" aria-hidden="true">
                          {isActive ? "✓" : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="pcp-pagination">
              <span className="pcp-pagination-info">
                共 {total} 张{totalPages > 1 ? ` · 第 ${page}/${totalPages} 页` : ""}
              </span>
              {totalPages > 1 && (
                <div className="pcp-pagination-btns">
                  <button
                    type="button"
                    className="pcp-btn"
                    disabled={page <= 1 || loadingList}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    className="pcp-btn"
                    disabled={page >= totalPages || loadingList}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    下一页
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="pcp-preview-col" aria-label="商品信息卡事实预览">
            {loadingDetail ? (
              <p className="pcp-state" role="status">
                正在读取完整 6+3 项商品事实…
              </p>
            ) : detailError ? (
              <p className="pcp-state is-error" role="alert">
                {detailError}
              </p>
            ) : previewCard ? (
              <ProductCardFactsView
                name={previewCard.name}
                revision={previewCard.revision}
                coverThumbnailUrl={previewCard.coverThumbnailUrl}
                fields={previewCard}
              />
            ) : (
              <div className="pcp-empty">
                <Icon name="box" />
                <strong>选择左侧商品卡预览详情</strong>
                <small>可在此核对 6 项必填事实与 3 项选填信息，确认后绑定到当前批次。</small>
              </div>
            )}
          </div>
        </div>

        <footer className="pcp-modal-foot">
          <span className="pcp-foot-summary">
            {previewCard ? `已选：${previewCard.name}` : "请选择一张在用商品信息卡"}
          </span>
          <div className="pcp-foot-actions">
            <button type="button" className="pcp-btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="pcp-btn is-primary"
              disabled={!canConfirm}
              onClick={() => {
                if (!previewCard) return;
                onConfirm(previewCard);
                onClose();
              }}
            >
              确认选择
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
