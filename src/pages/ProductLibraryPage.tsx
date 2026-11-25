import { useEffect, useRef, useState } from "react";
import {
  emptyProductCardFields,
  type ProductCardFields,
  type ProductCardStatus,
} from "../../shared/product-card";
import {
  productCardsApi,
  type ApiProductCard,
  type ApiProductCardSummary,
} from "../api/client";
import { AppShell } from "../components/AppShell";
import { InfoTip } from "../components/ui/InfoTip";
import { formatShortDateTime } from "../features/home/onboarding-attachments";
import {
  ProductCardEditorForm,
  productCardFieldsFromCard,
  supplierImagesFromCard,
  toCreateSupplierImagePayloads,
  toUpdateSupplierImagePayloads,
  type ProductCardSupplierImageDraft,
} from "../features/products/ProductCardEditorForm";
import { Icon } from "./shared";
import "./ProductLibraryPage.css";

type ProductStatusFilter = ProductCardStatus | "all";

const PAGE_SIZE = 24;

function statusLabel(status: ProductCardStatus): string {
  return status === "published" ? "在用" : "已归档";
}

export function ProductLibraryPage({
  initialSelectedId,
  navigate,
}: {
  initialSelectedId?: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<ProductStatusFilter>("published");
  const [keywordInput, setKeywordInput] = useState("");
  const [submittedKeyword, setSubmittedKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusCounts, setStatusCounts] = useState({ published: 0, archived: 0, all: 0 });
  const [items, setItems] = useState<ApiProductCardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [selectedDetail, setSelectedDetail] = useState<ApiProductCard | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [editFields, setEditFields] = useState<ProductCardFields>(() => emptyProductCardFields());
  const [editImages, setEditImages] = useState<ProductCardSupplierImageDraft[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [mutatingStatus, setMutatingStatus] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createFields, setCreateFields] = useState<ProductCardFields>(() => emptyProductCardFields());
  const [createImages, setCreateImages] = useState<ProductCardSupplierImageDraft[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const countsSequence = useRef(0);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const pinnedSelectionRef = useRef<string | null>(initialSelectedId ?? null);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const previous = document.title;
    document.title = "商品库 · PicAgent";
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    if (!initialSelectedId) return;
    pinnedSelectionRef.current = initialSelectedId;
    setSelectedId(initialSelectedId);
  }, [initialSelectedId]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Debounced live search when typing
  useEffect(() => {
    const trimmed = keywordInput.trim();
    if (trimmed === submittedKeyword) return;
    const timer = window.setTimeout(() => {
      setSubmittedKeyword(trimmed);
      setPage(1);
    }, trimmed === "" ? 0 : 220);
    return () => window.clearTimeout(timer);
  }, [keywordInput, submittedKeyword]);

  const notify = (message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast("");
      toastTimerRef.current = null;
    }, 2600);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Fetch counts for left status rail
  useEffect(() => {
    let active = true;
    const seq = ++countsSequence.current;
    void Promise.all([
      productCardsApi.list({ status: "published", limit: 1 }),
      productCardsApi.list({ status: "archived", limit: 1 }),
    ])
      .then(([pubRes, archRes]) => {
        if (!active || seq !== countsSequence.current) return;
        setStatusCounts({
          published: pubRes.total,
          archived: archRes.total,
          all: pubRes.total + archRes.total,
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [reloadTick]);

  // Fetch product cards list
  useEffect(() => {
    let active = true;
    const sequence = ++listSequence.current;
    setLoading(true);
    setError("");
    void productCardsApi
      .list({
        status: statusFilter,
        keyword: submittedKeyword || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      })
      .then((result) => {
        if (!active || sequence !== listSequence.current) return;
        if (result.items.length === 0 && result.total > 0 && page > 1) {
          const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
          setTotal(result.total);
          setPage(lastPage);
          return;
        }
        setItems(result.items);
        setTotal(result.total);
        const pinned = pinnedSelectionRef.current;
        if (pinned) {
          pinnedSelectionRef.current = null;
          setSelectedId(pinned);
          return;
        }
        setSelectedId((current) => {
          if (current && result.items.some((item) => item.id === current)) return current;
          return result.items[0]?.id ?? null;
        });
      })
      .catch((cause) => {
        if (!active || sequence !== listSequence.current) return;
        setError(cause instanceof Error ? cause.message : "商品信息卡加载失败，请重试");
      })
      .finally(() => {
        if (active && sequence === listSequence.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [statusFilter, submittedKeyword, page, reloadTick]);

  // Fetch full detail when selectedId changes
  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      setLoadingDetail(false);
      return;
    }
    let active = true;
    const sequence = ++detailSequence.current;
    setLoadingDetail(true);
    void productCardsApi
      .get(selectedId)
      .then((card) => {
        if (!active || sequence !== detailSequence.current) return;
        setSelectedDetail(card);
        setEditFields(productCardFieldsFromCard(card));
        setEditImages(supplierImagesFromCard(card));
      })
      .catch((cause) => {
        if (!active || sequence !== detailSequence.current) return;
        setSelectedDetail(null);
        setError(cause instanceof Error ? cause.message : "商品卡详情加载失败");
      })
      .finally(() => {
        if (active && sequence === detailSequence.current) setLoadingDetail(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  // Keyboard Escape for modals
  useEffect(() => {
    if (!createOpen && !deleteTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deleteTarget && !deleting) {
        setDeleteTarget(null);
      } else if (createOpen && !creating) {
        setCreateOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createOpen, creating, deleteTarget, deleting]);

  const handleStatusFilterChange = (next: ProductStatusFilter) => {
    setStatusFilter(next);
    setPage(1);
  };

  const handleSearch = () => {
    const trimmed = keywordInput.trim();
    if (trimmed !== submittedKeyword) {
      setSubmittedKeyword(trimmed);
      setPage(1);
    } else if (page !== 1) {
      setPage(1);
    } else {
      setReloadTick((n) => n + 1);
    }
  };

  const handleClearSearch = () => {
    setKeywordInput("");
    setSubmittedKeyword("");
    setPage(1);
  };

  const handlePageChange = (nextPage: number) => {
    const clamped = Math.min(totalPages, Math.max(1, nextPage));
    if (clamped === page) return;
    setPage(clamped);
  };

  const openCreateModal = () => {
    setCreateFields(emptyProductCardFields());
    setCreateImages([]);
    setCreateError("");
    setCreateOpen(true);
  };

  const handleCreateSubmit = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError("");
    setError("");
    try {
      const created = await productCardsApi.create({
        ...createFields,
        supplierImages: toCreateSupplierImagePayloads(createImages),
      });
      setCreateOpen(false);
      setSelectedDetail(created);
      setEditFields(productCardFieldsFromCard(created));
      setEditImages(supplierImagesFromCard(created));
      pinnedSelectionRef.current = created.id;
      setSelectedId(created.id);
      if (statusFilter === "archived") {
        setStatusFilter("published");
      }
      setPage(1);
      setReloadTick((n) => n + 1);
      notify(`商品信息卡「${created.name}」已创建`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "新建商品信息卡失败，请重试";
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  };

  const handleEditSubmit = async () => {
    if (!selectedDetail || savingEdit) return;
    const targetId = selectedDetail.id;
    setSavingEdit(true);
    setError("");
    try {
      const updated = await productCardsApi.update(targetId, {
        ...editFields,
        supplierImages: toUpdateSupplierImagePayloads(editImages),
      });
      if (selectedIdRef.current === targetId) {
        setSelectedDetail(updated);
        setEditFields(productCardFieldsFromCard(updated));
        setEditImages(supplierImagesFromCard(updated));
        pinnedSelectionRef.current = updated.id;
      }
      setReloadTick((n) => n + 1);
      notify(`商品信息卡已保存（v${updated.revision}）`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存修改失败，请重试");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleToggleArchive = async (card: ApiProductCard) => {
    if (mutatingStatus) return;
    const targetId = card.id;
    setMutatingStatus(true);
    setError("");
    try {
      const updated =
        card.status === "published"
          ? await productCardsApi.archive(targetId)
          : await productCardsApi.restore(targetId);
      if (selectedIdRef.current === targetId) {
        setSelectedDetail(updated);
        setEditFields(productCardFieldsFromCard(updated));
        setEditImages(supplierImagesFromCard(updated));
      }
      notify(updated.status === "archived" ? "商品信息卡已归档" : "商品信息卡已恢复在用");
      setReloadTick((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新商品卡状态失败，请重试");
    } finally {
      setMutatingStatus(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await productCardsApi.delete(deleteTarget.id);
      if (selectedId === deleteTarget.id) {
        setSelectedId(null);
        setSelectedDetail(null);
      }
      setDeleteTarget(null);
      notify("商品信息卡已删除");
      setReloadTick((n) => n + 1);
    } catch (cause) {
      setDeleteTarget(null);
      setError(cause instanceof Error ? cause.message : "删除商品信息卡失败，请重试");
    } finally {
      setDeleting(false);
    }
  };

  const filterItems: Array<{ value: ProductStatusFilter; label: string; count: number }> = [
    { value: "published", label: "在用", count: statusCounts.published },
    { value: "archived", label: "已归档", count: statusCounts.archived },
    { value: "all", label: "全部", count: statusCounts.all },
  ];

  return (
    <AppShell
      activeNav="products"
      navigate={navigate}
      fullHeight
      crumbs={[{ label: "商品库" }]}
      statusText={loading ? "正在同步商品库…" : `共 ${statusCounts.all} 款`}
      statusTone={loading ? "running" : error ? "error" : "pass"}
    >
      <main className="workarea styles-layout style-library-workarea product-library-workarea">
        {/* Left Status Filter Rail */}
        <section className="panel style-filter-panel product-filter-panel">
          <header className="panel-header">
            <div className="product-col-title-group">
              <strong className="panel-title">状态</strong>
              <InfoTip
                title="状态与历史快照"
                label="状态与快照说明"
                align="start"
                content="已归档的商品卡不再出现在创作页选择器中；修改、归档或删除商品卡均不影响历史套图与复刻批次已冻结的商品快照。"
              />
            </div>
            <span className="product-col-count">{statusCounts.all}</span>
          </header>
          <div className="panel-scroll">
            <div className="product-filter-list" role="radiogroup" aria-label="商品卡状态筛选">
              {filterItems.map((item) => {
                const active = statusFilter === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`product-filter-item ${active ? "is-active" : ""}`}
                    data-status-filter={item.value}
                    onClick={() => handleStatusFilterChange(item.value)}
                  >
                    <span>{item.label}</span>
                    <span className="product-filter-cnt">{item.count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Center Catalog Column */}
        <section className="styles-center style-library-center product-library-center">
          <header className="panel-header style-catalog-toolbar">
            <div className="product-col-title-group">
              <strong className="panel-title">商品信息卡</strong>
              <span className="product-col-count">{total} 款</span>
            </div>
            <div className="product-library-header-actions">
              <button className="btn" type="button" onClick={() => navigate("/")}>
                AI 建档
              </button>
              <button className="btn btn-primary" type="button" onClick={openCreateModal}>
                <Icon name="plus" />
                <span>新建商品卡</span>
              </button>
            </div>
          </header>

          <div className="product-search-bar">
            <div className="product-search-wrap">
              <Icon name="search" />
              <input
                className="product-search-input"
                type="search"
                aria-label="搜索商品信息卡"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleSearch();
                }}
                placeholder="搜索商品名称或核心卖点"
              />
              {(keywordInput || submittedKeyword) && (
                <button
                  type="button"
                  className="product-search-clear"
                  aria-label="清除搜索"
                  title="清除搜索"
                  onClick={handleClearSearch}
                >
                  <Icon name="x" />
                </button>
              )}
            </div>
            <button className="btn" type="button" onClick={handleSearch}>
              搜索
            </button>
          </div>

          <div className="product-library-results">
            <div className="product-card-grid">
              {loading ? (
                <div className="style-library-loading">正在加载商品信息卡…</div>
              ) : items.length > 0 ? (
                items.map((item) => {
                  const isActive = selectedId === item.id;
                  return (
                    <article
                      key={item.id}
                      className={`product-card-item ${isActive ? "is-active" : ""}`}
                      data-product-card-id={item.id}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <div className="product-card-top">
                        <div className="product-card-thumb">
                          {item.coverThumbnailUrl ? (
                            <img src={item.coverThumbnailUrl} alt={item.name} loading="lazy" />
                          ) : (
                            <div className="product-card-thumb-empty">
                              <Icon name="box" />
                            </div>
                          )}
                        </div>
                        <div className="product-card-head-info">
                          <div className="product-card-status-row">
                            <span className={`product-status-dot is-${item.status}`}>
                              <i aria-hidden="true" />
                              <span>{statusLabel(item.status)}</span>
                            </span>
                            <span className="product-card-rev">v{item.revision}</span>
                          </div>
                          <h3 className="product-card-name" title={item.name}>
                            {item.name}
                          </h3>
                        </div>
                      </div>

                      {item.sellingPoints.length > 0 && (
                        <ul className="product-card-points" aria-label="核心卖点摘要">
                          {item.sellingPoints.slice(0, 2).map((point, index) => (
                            <li key={`${index}-${point}`} title={point}>
                              {point}
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="product-card-foot">
                        <span className="product-card-time">
                          {formatShortDateTime(item.updatedAt)}
                        </span>
                        {item.status === "published" && (
                          <div className="product-card-quick-actions">
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={(event) => {
                                event.stopPropagation();
                                navigate(`/create/suite?productCardId=${encodeURIComponent(item.id)}`);
                              }}
                            >
                              去套图
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={(event) => {
                                event.stopPropagation();
                                navigate(
                                  `/create/replica?productCardId=${encodeURIComponent(item.id)}`,
                                );
                              }}
                            >
                              去复刻
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={(event) => {
                                event.stopPropagation();
                                navigate(
                                  `/create/aplus?productCardId=${encodeURIComponent(item.id)}`,
                                );
                              }}
                            >
                              生成 A+
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="style-library-empty">
                  <strong>
                    {submittedKeyword
                      ? "没有匹配的商品信息卡"
                      : statusFilter === "archived"
                        ? "暂无已归档的商品信息卡"
                        : "暂无商品信息卡"}
                  </strong>
                  <p>
                    {submittedKeyword
                      ? "可尝试更换商品名称或核心卖点关键词，或清除搜索条件。"
                      : "点击右上角「新建商品卡」录入新品，或前往首页通过 AI 建档。"}
                  </p>
                  {submittedKeyword ? (
                    <button
                      className="btn"
                      type="button"
                      style={{ marginTop: 8 }}
                      onClick={handleClearSearch}
                    >
                      清除搜索
                    </button>
                  ) : (
                    statusFilter !== "archived" && (
                      <button
                        className="btn btn-primary"
                        type="button"
                        style={{ marginTop: 8 }}
                        onClick={openCreateModal}
                      >
                        <Icon name="plus" />
                        <span>新建商品卡</span>
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          </div>

          <footer className="product-library-pagination" aria-label="商品库分页">
            <span className="style-pagination-info">
              第 {page} / {totalPages} 页 · 共 {total} 款
            </span>
            <div className="style-pagination-actions">
              <button
                className="btn btn-sm"
                type="button"
                disabled={loading || page <= 1}
                onClick={() => handlePageChange(page - 1)}
              >
                上一页
              </button>
              <button
                className="btn btn-sm"
                type="button"
                disabled={loading || page >= totalPages}
                onClick={() => handlePageChange(page + 1)}
              >
                下一页
              </button>
            </div>
          </footer>
        </section>

        {/* Right Flat Inspector */}
        <aside className="panel right style-inspector product-library-inspector">
          <header className="panel-header">
            <div className="product-col-title-group">
              <strong className="panel-title" title={selectedDetail?.name}>
                {selectedDetail ? selectedDetail.name : "商品卡详情"}
              </strong>
              {selectedDetail && (
                <span className="product-version-chip" data-testid="product-revision-badge">
                  v{selectedDetail.revision}
                </span>
              )}
            </div>
            {selectedDetail && (
              <div className="product-inspector-header-ops">
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={selectedDetail.status === "published" ? "归档" : "恢复在用"}
                  title={selectedDetail.status === "published" ? "归档" : "恢复在用"}
                  disabled={mutatingStatus || savingEdit || deleting}
                  onClick={() => void handleToggleArchive(selectedDetail)}
                >
                  <Icon name="archive" />
                </button>
                <button
                  className="icon-btn product-icon-danger"
                  type="button"
                  aria-label="删除"
                  title="删除"
                  disabled={mutatingStatus || savingEdit || deleting}
                  onClick={() =>
                    setDeleteTarget({ id: selectedDetail.id, name: selectedDetail.name })
                  }
                >
                  <Icon name="trash" />
                </button>
              </div>
            )}
          </header>

          {selectedId ? (
            loadingDetail && !selectedDetail ? (
              <div className="style-library-inspector-empty">
                <Icon name="box" />
                <strong>正在加载商品卡详情…</strong>
              </div>
            ) : selectedDetail ? (
              <div className="product-inspector-body">
                <ProductCardEditorForm
                  key={selectedDetail.id}
                  idPrefix={`edit-${selectedDetail.id}`}
                  fields={editFields}
                  supplierImages={editImages}
                  onFieldsChange={setEditFields}
                  onSupplierImagesChange={setEditImages}
                  onSubmit={handleEditSubmit}
                  submitLabel="保存修改"
                  submitting={savingEdit}
                  layout="panel"
                  topSlot={
                    <div className="product-inspector-action-bar">
                      <div className="product-inspector-quick-btns">
                        {selectedDetail.status === "published" ? (
                          <>
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() =>
                                navigate(
                                  `/create/suite?productCardId=${encodeURIComponent(selectedDetail.id)}`,
                                )
                              }
                            >
                              去套图
                            </button>
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() =>
                                navigate(
                                  `/create/replica?productCardId=${encodeURIComponent(selectedDetail.id)}`,
                                )
                              }
                            >
                              去复刻
                            </button>
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() =>
                                navigate(
                                  `/create/aplus?productCardId=${encodeURIComponent(selectedDetail.id)}`,
                                )
                              }
                            >
                              生成 A+
                            </button>
                          </>
                        ) : (
                          <span className="product-status-dot is-archived">
                            <i aria-hidden="true" />
                            <span>已归档</span>
                          </span>
                        )}
                      </div>
                      <span className="product-card-time">
                        更新于 {formatShortDateTime(selectedDetail.updatedAt)}
                      </span>
                    </div>
                  }
                />
              </div>
            ) : (
              <div className="style-library-inspector-empty">
                <Icon name="alert" />
                <strong>未找到该商品信息卡</strong>
                <span>卡片可能已被删除，请从中间列表重新选择。</span>
              </div>
            )
          ) : (
            <div className="style-library-inspector-empty">
              <Icon name="box" />
              <strong>选择一张商品信息卡</strong>
              <span>点击左侧列表查看与编辑，或点击上方「新建商品卡」录入新品。</span>
            </div>
          )}
        </aside>
      </main>

      {/* Manual Create Modal */}
      {createOpen && (
        <div
          className="style-library-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !creating) setCreateOpen(false);
          }}
        >
          <section
            className="product-create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-create-modal-title"
          >
            <header>
              <h2 id="product-create-modal-title">新建商品信息卡</h2>
              <button
                className="icon-btn"
                type="button"
                aria-label="关闭新建弹窗"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
              >
                <Icon name="x" />
              </button>
            </header>
            <div className="product-create-modal-body">
              {createError && (
                <div className="product-inline-error" role="alert">
                  {createError}
                </div>
              )}
              <ProductCardEditorForm
                idPrefix="create-product-card"
                fields={createFields}
                supplierImages={createImages}
                onFieldsChange={setCreateFields}
                onSupplierImagesChange={setCreateImages}
                onSubmit={handleCreateSubmit}
                submitLabel="保存到商品库"
                submitting={creating}
                layout="panel"
                footerExtra={
                  <button
                    className="btn"
                    type="button"
                    disabled={creating}
                    onClick={() => setCreateOpen(false)}
                  >
                    取消
                  </button>
                }
              />
            </div>
          </section>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          className="style-library-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting) setDeleteTarget(null);
          }}
        >
          <section
            className="style-delete-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-delete-confirm-title"
          >
            <header>
              <h2 id="product-delete-confirm-title">确认删除「{deleteTarget.name}」？</h2>
              <button
                className="icon-btn"
                type="button"
                aria-label="关闭删除确认"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                <Icon name="x" />
              </button>
            </header>
            <p className="style-delete-confirm-desc">
              删除后将永久移除该商品信息卡及其供应商参考图，且不可恢复；已生成的商品套图与爆品图复刻批次所冻结的历史商品卡快照不受影响。
            </p>
            <div className="style-delete-confirm-actions">
              <button
                className="btn"
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                className="btn btn-danger"
                type="button"
                disabled={deleting}
                onClick={() => void handleConfirmDelete()}
              >
                {deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </section>
        </div>
      )}

      {error && (
        <div className="suite-toast show" role="alert">
          {error}
        </div>
      )}
      {toast && (
        <div className="suite-toast show" role="status">
          {toast}
        </div>
      )}
    </AppShell>
  );
}
