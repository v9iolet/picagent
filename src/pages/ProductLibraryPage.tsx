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

function statusBadgeClass(status: ProductCardStatus): string {
  return status === "published" ? "pass" : "";
}

function filterSummaryLabel(status: ProductStatusFilter): string {
  if (status === "published") return "在用商品卡";
  if (status === "archived") return "已归档商品卡";
  return "全部商品卡";
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

  return (
    <AppShell
      activeNav="products"
      navigate={navigate}
      fullHeight
      crumbs={[{ label: "商品库" }]}
      statusText={loading ? "正在同步商品库…" : `共 ${total} 款`}
      statusTone={loading ? "running" : error ? "error" : "pass"}
    >
      <main className="workarea styles-layout style-library-workarea product-library-workarea">
        {/* Left filter panel */}
        <section className="panel style-filter-panel">
          <header className="panel-header">
            <div>
              <strong className="panel-title">商品筛选</strong>
              <div className="panel-subtitle">按状态筛选商品信息卡</div>
            </div>
            <span className="badge">{total} 款</span>
          </header>
          <div className="panel-scroll">
            <div className="style-filters">
              <div className="style-filter-group">
                <h3>状态</h3>
                {(
                  [
                    ["published", "在用"],
                    ["archived", "已归档"],
                    ["all", "全部"],
                  ] as [ProductStatusFilter, string][]
                ).map(([value, label]) => (
                  <label className="style-check" key={value}>
                    <input
                      type="radio"
                      name="productCardStatus"
                      checked={statusFilter === value}
                      onChange={() => handleStatusFilterChange(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="style-filter-note">
                <Icon name="box" />
                <p>
                  供应商参考图仅用于商品库认款展示与建档识别，不流入创作页生图实拍原图区；修改、归档或删除商品卡均不影响历史套图与爆品图复刻批次已冻结的快照。
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Center catalog */}
        <section className="styles-center style-library-center product-library-center">
          <header className="panel-header style-catalog-toolbar">
            <div>
              <strong className="panel-title">商品信息卡</strong>
              <div className="panel-subtitle">
                集中维护客观商品事实与供应商参考图，单击卡片在右侧查看与编辑
              </div>
            </div>
            <div className="product-library-header-actions">
              <button className="btn btn-primary" type="button" onClick={openCreateModal}>
                <Icon name="plus" />
                <span>手动新建商品卡</span>
              </button>
            </div>
          </header>

          <div className="style-library-toolbar">
            <div className="search-wrap">
              <input
                className="input"
                type="search"
                aria-label="搜索商品信息卡"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleSearch();
                }}
                placeholder="搜索商品名称、内部 SKU / 款号或商品类目"
              />
            </div>
            <button className="btn" type="button" onClick={handleSearch}>
              搜索
            </button>
          </div>

          <div className="style-boundary">
            <strong>{filterSummaryLabel(statusFilter)}</strong>
            <span>
              {submittedKeyword
                ? `关键词「${submittedKeyword}」命中 ${total} 款商品`
                : `当前共 ${total} 款商品信息卡`}
            </span>
            {submittedKeyword && (
              <div className="product-boundary-clear">
                <button className="btn" type="button" onClick={handleClearSearch}>
                  清除搜索
                </button>
              </div>
            )}
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
                              <span>无参考图</span>
                            </div>
                          )}
                        </div>
                        <div className="product-card-head-info">
                          <div className="product-card-badges">
                            <span className={`badge ${statusBadgeClass(item.status)}`}>
                              {statusLabel(item.status)}
                            </span>
                            <span className="badge product-category-badge">{item.category}</span>
                            {item.skuCode && (
                              <span className="badge product-sku-badge">{item.skuCode}</span>
                            )}
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
                          v{item.revision} · {new Date(item.updatedAt).toLocaleString("zh-CN")}
                        </span>
                        {item.status === "published" && (
                          <div className="product-card-quick-actions">
                            <button
                              type="button"
                              className="product-card-quick-btn"
                              onClick={(event) => {
                                event.stopPropagation();
                                navigate(`/create/suite?productCardId=${encodeURIComponent(item.id)}`);
                              }}
                            >
                              去生成套图
                            </button>
                            <button
                              type="button"
                              className="product-card-quick-btn"
                              onClick={(event) => {
                                event.stopPropagation();
                                navigate(`/create/replica?productCardId=${encodeURIComponent(item.id)}`);
                              }}
                            >
                              去爆品图复刻
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
                        : "商品库还没有商品信息卡"}
                  </strong>
                  <p>
                    {submittedKeyword
                      ? "可以尝试更换搜索词或切换左侧状态筛选。"
                      : "点击右上角「手动新建商品卡」录入第一款新品资料。"}
                  </p>
                  {!submittedKeyword && statusFilter !== "archived" && (
                    <button
                      className="btn btn-primary"
                      type="button"
                      style={{ marginTop: 8 }}
                      onClick={openCreateModal}
                    >
                      <Icon name="plus" />
                      <span>手动新建商品卡</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <footer className="style-library-pagination" aria-label="商品库分页">
            <span className="style-pagination-info">
              第 {page} / {totalPages} 页 · 共 {total} 款
            </span>
            <div className="style-pagination-actions">
              <button
                className="btn"
                type="button"
                disabled={loading || page <= 1}
                onClick={() => handlePageChange(page - 1)}
              >
                上一页
              </button>
              <button
                className="btn"
                type="button"
                disabled={loading || page >= totalPages}
                onClick={() => handlePageChange(page + 1)}
              >
                下一页
              </button>
            </div>
          </footer>
        </section>

        {/* Right detail / editor inspector */}
        <aside className="panel right style-inspector product-library-inspector">
          <header className="panel-header">
            <div>
              <strong className="panel-title">商品卡详情与编辑</strong>
              <div className="panel-subtitle">
                {selectedDetail
                  ? `修订版本 v${selectedDetail.revision} · 保存后自动递增版本`
                  : "选择商品卡查看或编辑客观事实与供应商图"}
              </div>
            </div>
            {selectedId && (
              <button
                className="icon-btn"
                type="button"
                aria-label="关闭详情"
                onClick={() => {
                  setSelectedId(null);
                  setSelectedDetail(null);
                }}
              >
                <Icon name="x" />
              </button>
            )}
          </header>

          {selectedId ? (
            loadingDetail && !selectedDetail ? (
              <div className="style-library-inspector-empty">
                <Icon name="box" />
                <strong>正在加载商品卡详情…</strong>
              </div>
            ) : selectedDetail ? (
              <div className="inspector-body product-inspector-body">
                <div className="product-inspector-meta-bar">
                  <div className="product-inspector-meta-top">
                    <div className="product-inspector-meta-badges">
                      <span className={`badge ${statusBadgeClass(selectedDetail.status)}`}>
                        {statusLabel(selectedDetail.status)}
                      </span>
                      <span className="badge mono" data-testid="product-revision-badge">
                        v{selectedDetail.revision}
                      </span>
                      {selectedDetail.skuCode && (
                        <span className="badge product-sku-badge">{selectedDetail.skuCode}</span>
                      )}
                    </div>
                    <span className="product-inspector-meta-time">
                      更新于 {new Date(selectedDetail.updatedAt).toLocaleString("zh-CN")}
                    </span>
                  </div>

                  <div className="product-inspector-ops">
                    <div className="product-inspector-ops-group">
                      {selectedDetail.status === "published" && (
                        <>
                          <button
                            className="btn"
                            type="button"
                            onClick={() =>
                              navigate(`/create/suite?productCardId=${encodeURIComponent(selectedDetail.id)}`)
                            }
                          >
                            去生成套图
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onClick={() =>
                              navigate(`/create/replica?productCardId=${encodeURIComponent(selectedDetail.id)}`)
                            }
                          >
                            去爆品图复刻
                          </button>
                        </>
                      )}
                    </div>
                    <div className="product-inspector-ops-group">
                      <button
                        className="btn"
                        type="button"
                        disabled={mutatingStatus || savingEdit || deleting}
                        onClick={() => void handleToggleArchive(selectedDetail)}
                      >
                        <Icon name="archive" />
                        <span>{selectedDetail.status === "published" ? "归档" : "恢复在用"}</span>
                      </button>
                      <button
                        className="btn btn-danger-outline"
                        type="button"
                        disabled={mutatingStatus || savingEdit || deleting}
                        onClick={() =>
                          setDeleteTarget({ id: selectedDetail.id, name: selectedDetail.name })
                        }
                      >
                        <Icon name="trash" />
                        <span>删除</span>
                      </button>
                    </div>
                  </div>
                </div>

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
                />
              </div>
            ) : (
              <div className="style-library-inspector-empty">
                <Icon name="alert" />
                <strong>未找到该商品信息卡</strong>
                <span>卡片可能已被删除，请从左侧列表重新选择。</span>
              </div>
            )
          ) : (
            <div className="style-library-inspector-empty">
              <Icon name="box" />
              <strong>选择一张商品信息卡</strong>
              <span>从中间列表点击卡片进行编辑，或点击上方「手动新建商品卡」创建新品。</span>
            </div>
          )}
        </aside>
      </main>

      {/* Manual create modal / drawer */}
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
              <div>
                <span className="style-library-modal-kicker">NEW PRODUCT CARD</span>
                <h2 id="product-create-modal-title">手动新建商品信息卡</h2>
                <p>补齐 7 项必填客观商品事实后即可保存到商品库，供商品套图与爆品图复刻复用</p>
              </div>
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

      {/* Delete confirmation modal */}
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
              <div>
                <span className="style-library-modal-kicker">DELETE PRODUCT CARD</span>
                <h2 id="product-delete-confirm-title">确认删除「{deleteTarget.name}」？</h2>
              </div>
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
