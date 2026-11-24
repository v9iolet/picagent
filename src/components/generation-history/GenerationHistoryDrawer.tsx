import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  buildFeedUrl,
  extractThumbnails,
  formatHistoryTime,
  GENERATION_HISTORY_PAGE_SIZE,
  mergeFeedPages,
  resolveCardCount,
  resolveItemStatus,
  type FeedPaginationState,
  type GenerationHistoryFeedItem,
  type GenerationHistoryFeedPage,
  type GenerationHistoryOrigin,
  type GenerationHistoryPipeline,
  type GenerationHistoryPipelineStatus,
} from "./history-model";
import "./generation-history.css";

export type {
  GenerationHistoryFeedItem,
  GenerationHistoryFeedPage,
  GenerationHistoryOrigin,
  GenerationHistoryPipeline,
  GenerationHistoryPipelineStatus,
};

export interface GenerationHistoryDrawerProps {
  origin: GenerationHistoryOrigin;
  open: boolean;
  onClose: () => void;
  onSelect: (suiteId: string) => void;
  currentSuiteId?: string | null;
  renderMeta?: (item: GenerationHistoryFeedItem) => ReactNode;
  title?: string;
}

async function fetchFeedPage(
  url: string,
  signal: AbortSignal,
): Promise<GenerationHistoryFeedPage> {
  const response = await fetch(url, { cache: "no-store", signal });
  const payload = (await response.json().catch(() => null)) as {
    data?: GenerationHistoryFeedPage;
    error?: { message?: string };
  } | null;
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error?.message ?? `读取生成记录失败 (${response.status})`);
  }
  return payload.data;
}

const DEBOUNCE_MS = 300;

export function GenerationHistoryDrawer({
  origin,
  open,
  onClose,
  onSelect,
  currentSuiteId,
  renderMeta,
  title = "生成记录",
}: GenerationHistoryDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);

  const [keywordInput, setKeywordInput] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [pagination, setPagination] = useState<FeedPaginationState>({
    items: [],
    total: 0,
    offset: 0,
    hasMore: false,
  });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [loadMoreError, setLoadMoreError] = useState("");
  const { items, total, offset, hasMore } = pagination;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      setKeywordInput("");
      setDebouncedKeyword("");
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedKeyword(keywordInput);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, keywordInput]);

  const loadPage = useCallback(
    async (nextOffset: number, reset: boolean, keyword: string) => {
      if (!reset && loadingMoreRef.current) return;
      if (reset) {
        abortRef.current?.abort();
        setLoading(true);
        setError("");
        setLoadMoreError("");
        loadingMoreRef.current = false;
        setLoadingMore(false);
      } else {
        loadingMoreRef.current = true;
        setLoadingMore(true);
        setLoadMoreError("");
      }

      const seq = ++requestSeqRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const url = buildFeedUrl({
          origin,
          keyword,
          limit: GENERATION_HISTORY_PAGE_SIZE,
          offset: nextOffset,
        });
        const page = await fetchFeedPage(url, controller.signal);
        if (seq !== requestSeqRef.current) return;

        setPagination((prev) => mergeFeedPages(prev.items, page, reset));
      } catch (err) {
        if (controller.signal.aborted || seq !== requestSeqRef.current) return;
        const text = err instanceof Error ? err.message : "读取生成记录失败，请重试";
        if (reset) {
          setError(text);
          setPagination({ items: [], total: 0, offset: 0, hasMore: false });
        } else {
          setLoadMoreError(text);
        }
      } finally {
        if (seq === requestSeqRef.current) {
          if (reset) setLoading(false);
          else {
            loadingMoreRef.current = false;
            setLoadingMore(false);
          }
        }
      }
    },
    [origin],
  );

  useEffect(() => {
    if (!open) return;
    void loadPage(0, true, debouncedKeyword);
  }, [open, origin, debouncedKeyword, loadPage]);

  useEffect(() => {
    if (!open || !hasMore || loading || loadingMore || error || loadMoreError) return;
    const sentinel = sentinelRef.current;
    const root = bodyRef.current;
    if (!sentinel || !root || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadPage(offset, false, debouncedKeyword);
        }
      },
      { root, rootMargin: "120px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [open, hasMore, loading, loadingMore, error, loadMoreError, offset, debouncedKeyword, loadPage]);

  if (!open) return null;

  const trimmedKeyword = debouncedKeyword.trim();

  return (
    <dialog
      ref={dialogRef}
      className="gh-drawer"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <header className="gh-header">
        <div className="gh-header-title">
          <h2>{title}</h2>
          {!loading && !error && total > 0 && <span className="gh-total">共 {total} 条</span>}
        </div>
        <button type="button" className="gh-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </header>

      <div className="gh-search">
        <input
          type="search"
          aria-label="搜索生成记录"
          placeholder="搜索批次名称…"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
        />
        {keywordInput && (
          <button
            type="button"
            className="gh-search-clear"
            onClick={() => {
              setKeywordInput("");
              setDebouncedKeyword("");
            }}
          >
            清空
          </button>
        )}
      </div>

      <div ref={bodyRef} className="gh-body">
        {loading ? (
          <p className="gh-state" role="status">
            正在加载生成记录…
          </p>
        ) : error ? (
          <div className="gh-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => void loadPage(0, true, debouncedKeyword)}>
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="gh-empty">
            <p>{trimmedKeyword ? "未找到匹配的生成记录" : "暂无生成记录"}</p>
            {trimmedKeyword && (
              <button
                type="button"
                onClick={() => {
                  setKeywordInput("");
                  setDebouncedKeyword("");
                }}
              >
                清空搜索
              </button>
            )}
          </div>
        ) : (
          <>
            <ul className="gh-list" aria-label="生成记录列表">
              {items.map((item) => {
                const thumbs = extractThumbnails(item, 4);
                const status = resolveItemStatus(item);
                const count = resolveCardCount(item);
                const timeLabel = formatHistoryTime(item.suite.createdAt);
                const isCurrent = Boolean(currentSuiteId && item.suite.id === currentSuiteId);
                const meta = renderMeta?.(item);
                return (
                  <li key={item.suite.id}>
                    <button
                      type="button"
                      className={`gh-item${isCurrent ? " is-current" : ""}`}
                      aria-current={isCurrent ? "true" : undefined}
                      data-history-item={item.suite.id}
                      data-current={isCurrent ? "true" : undefined}
                      onClick={() => {
                        onSelect(item.suite.id);
                        onClose();
                      }}
                    >
                      <span className="gh-collage" data-count={thumbs.length} aria-hidden="true">
                        {thumbs.length === 0 ? (
                          <span>无图</span>
                        ) : (
                          thumbs.map((src, idx) => (
                            <img key={`${item.suite.id}-thumb-${idx}`} src={src} alt="" loading="lazy" />
                          ))
                        )}
                      </span>
                      <span className="gh-item-body">
                        <span className="gh-item-top">
                          <strong className="gh-item-name">{item.suite.name}</strong>
                          <span className="gh-status" data-status={status.tone}>
                            {status.tone === "running" && <span className="gh-status-dot" aria-hidden="true" />}
                            {status.label}
                          </span>
                        </span>
                        <span className="gh-item-meta">
                          {isCurrent && <span className="gh-current-badge">当前</span>}
                          {meta}
                          <span className="gh-meta-count">{count} 张</span>
                          {timeLabel && <time dateTime={item.suite.createdAt}>{timeLabel}</time>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {loadMoreError && (
              <div className="gh-load-more-error" role="alert">
                <span>{loadMoreError}</span>
                <button type="button" onClick={() => void loadPage(offset, false, debouncedKeyword)}>
                  重试
                </button>
              </div>
            )}

            {loadingMore && (
              <p className="gh-footer-status" role="status">
                正在加载更多…
              </p>
            )}

            {hasMore && !loadMoreError && <div ref={sentinelRef} className="gh-sentinel" aria-hidden="true" />}

            {!hasMore && items.length > 0 && <p className="gh-footer-end">已显示全部记录</p>}
          </>
        )}
      </div>
    </dialog>
  );
}
