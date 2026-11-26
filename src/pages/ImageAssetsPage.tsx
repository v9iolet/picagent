import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/ToastProvider";
import { useEffect, useMemo, useRef, useState } from "react";
import { suiteApi, type ApiLibraryResource, type ApiLibraryResourceType } from "../api/client";
import { AppShell } from "../components/AppShell";
import { InfoTip } from "../components/ui/InfoTip";
import {
  dimensionsFor,
  promptSnapshotValue,
  promptTextFor,
  ratioFor,
  resourceLabel,
  sourceOriginLabel,
  stageLabel,
  statusClass,
  statusLabel,
} from "../features/library/library-helpers";
import { Icon } from "./shared";

type ImageResourceFilter = "all" | Exclude<ApiLibraryResourceType, "prompt_template" | "input_image">;
type DeleteConfirmState =
  | { mode: "single"; resource: ApiLibraryResource }
  | { mode: "batch"; ids: string[] };

const PAGE_SIZE = 24;
const BATCH_DELETE_MAX = 100;

function imagePreview(resource: ApiLibraryResource) {
  if (resource.previewUrl) return <img src={resource.previewUrl} alt={resource.title} loading="lazy" />;
  return (
    <div className="style-library-no-preview">
      <Icon name={resource.resourceType === "process_image" ? "history" : "image"} />
      <span>暂无预览</span>
    </div>
  );
}

export function ImageAssetsPage({ navigate }: { navigate: (to: string) => void }) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [resourceFilter, setResourceFilter] = useState<ImageResourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "published" | "draft" | "archived">("published");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const [items, setItems] = useState<ApiLibraryResource[]>([]);
  const [selected, setSelected] = useState<ApiLibraryResource | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { showToast: notify } = useToast();
  const [promptModal, setPromptModal] = useState<ApiLibraryResource | null>(null);
  const loadSequence = useRef(0);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const previous = document.title;
    document.title = "图片库 · PicAgent";
    return () => { document.title = previous; };
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    let active = true;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    void suiteApi
      .listLibraryResources({
        scope: "image",
        resourceType: resourceFilter === "all" ? undefined : resourceFilter,
        status: statusFilter === "all" ? undefined : statusFilter,
        query: submittedQuery || undefined,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((result) => {
        if (!active || sequence !== loadSequence.current) return;
        const visible = result.items.filter(
          (item) => item.resourceType !== "prompt_template" && item.resourceType !== "input_image",
        );
        if (visible.length === 0 && result.total > 0 && page > 1) {
          const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
          setTotal(result.total);
          setCheckedIds(new Set());
          setPage(lastPage);
          return;
        }
        const visibleIds = new Set(visible.map((item) => item.id));
        setItems(visible);
        setTotal(result.total);
        setCheckedIds((current) => {
          if (!current.size) return current;
          const next = new Set<string>();
          current.forEach((id) => { if (visibleIds.has(id)) next.add(id); });
          return next;
        });
        setSelected((current) => visible.find((item) => item.id === current?.id) ?? visible[0] ?? null);
      })
      .catch((cause) => {
        if (!active || sequence !== loadSequence.current) return;
        setError(cause instanceof Error ? cause.message : "图片资产加载失败，请重试");
      })
      .finally(() => {
        if (active && sequence === loadSequence.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [statusFilter, resourceFilter, submittedQuery, page, reloadTick]);

  const visibleCheckedIds = useMemo(
    () => items.filter((item) => checkedIds.has(item.id)).map((item) => item.id),
    [items, checkedIds],
  );
  const allVisibleChecked = items.length > 0 && visibleCheckedIds.length === items.length;
  const someVisibleChecked = visibleCheckedIds.length > 0 && !allVisibleChecked;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleChecked;
  }, [someVisibleChecked]);

  const handleResourceFilterChange = (next: ImageResourceFilter) => {
    setResourceFilter(next);
    setPage(1);
    setCheckedIds(new Set());
  };

  const handleStatusFilterChange = (next: "all" | "published" | "draft" | "archived") => {
    setStatusFilter(next);
    setPage(1);
    setCheckedIds(new Set());
  };

  const handleSearch = () => {
    const trimmed = query.trim();
    setCheckedIds(new Set());
    if (trimmed !== submittedQuery) {
      setSubmittedQuery(trimmed);
      setPage(1);
    } else if (page !== 1) {
      setPage(1);
    } else {
      setReloadTick((n) => n + 1);
    }
  };

  const handlePageChange = (nextPage: number) => {
    const clamped = Math.min(totalPages, Math.max(1, nextPage));
    if (clamped === page) return;
    setCheckedIds(new Set());
    setPage(clamped);
  };

  const toggleCheck = (id: string) => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < BATCH_DELETE_MAX) next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (allVisibleChecked) {
        items.forEach((item) => next.delete(item.id));
      } else {
        items.slice(0, BATCH_DELETE_MAX).forEach((item) => next.add(item.id));
      }
      return next;
    });
  };

  const clearChecked = () => {
    setCheckedIds(new Set());
  };

  const changeStatus = async (resource: ApiLibraryResource, status: "published" | "archived") => {
    try {
      const updated = await suiteApi.setLibraryResourceStatus(resource.id, status);
      setSelected(updated);
      notify(status === "published" ? "资源已发布" : "资源已归档");
      setReloadTick((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "状态更新失败，请重试");
    }
  };

  const executeDelete = async () => {
    if (!deleteConfirm || deleting) return;
    setDeleting(true);
    setError("");
    try {
      if (deleteConfirm.mode === "single") {
        await suiteApi.deleteLibraryResource(deleteConfirm.resource.id);
        setCheckedIds((current) => {
          const next = new Set(current);
          next.delete(deleteConfirm.resource.id);
          return next;
        });
        setDeleteConfirm(null);
        notify("图片已从资源库删除");
      } else {
        const ids = deleteConfirm.ids.slice(0, BATCH_DELETE_MAX);
        const result = await suiteApi.batchDeleteLibraryResources(ids);
        const removed = new Set([...result.deletedIds, ...result.alreadyDeletedIds]);
        setCheckedIds((current) => {
          const next = new Set(current);
          removed.forEach((id) => next.delete(id));
          return next;
        });
        setDeleteConfirm(null);
        notify(`已删除 ${removed.size} 张图片`);
      }
      setReloadTick((n) => n + 1);
    } catch (cause) {
      setDeleteConfirm(null);
      setError(cause instanceof Error ? cause.message : "删除失败，请重试");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AppShell
      activeNav="assets"
      navigate={navigate}
      fullHeight
      crumbs={[{ label: "图片库" }]}
      statusText={loading ? "正在同步图片资产…" : `共 ${total} 项`}
      statusTone={loading ? "running" : error ? "error" : "pass"}
    >
      <main className="workarea styles-layout style-library-workarea">
        <section className="panel style-filter-panel">
          <header className="panel-header">
            <strong className="panel-title">图片筛选</strong>
            <span className="badge">{total} 项</span>
          </header>
          <div className="panel-scroll">
            <div className="style-filters">
              <div className="style-filter-group">
                <div className="style-filter-group-head">
                  <h3>资产类型</h3>
                  <InfoTip
                    label="资产类型说明"
                    title="图片沉淀范围"
                    align="start"
                    content="图片库仅沉淀 AI 生成与派生图片，每张保留对应提示词快照；历史引用保持稳定，不受后续删除影响。"
                  />
                </div>
                {([
                  ["all", "全部生成图"],
                  ["task_image_version", "AI 生成结果"],
                  ["base_image", "白底底图"],
                  ["process_image", "过程图"],
                  ["reverse_reference_asset", "爆品图反推"],
                ] as [ImageResourceFilter, string][]).map(([value, label]) => (
                  <label className="style-check" key={value}>
                    <input type="radio" name="resourceType" checked={resourceFilter === value} onChange={() => handleResourceFilterChange(value)} />
                    {label}
                  </label>
                ))}
              </div>
              <div className="style-filter-group">
                <h3>状态</h3>
                {([
                  ["published", "已发布"],
                  ["draft", "草稿"],
                  ["archived", "已归档"],
                  ["all", "全部状态"],
                ] as const).map(([value, label]) => (
                  <label className="style-check" key={value}>
                    <input type="radio" name="resourceStatus" checked={statusFilter === value} onChange={() => handleStatusFilterChange(value)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="styles-center style-library-center style-assets-center">
          <header className="panel-header style-catalog-toolbar">
            <strong className="panel-title">图片资产</strong>
          </header>
          <div className="style-library-toolbar">
            <div className="search-wrap">
              <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") handleSearch(); }} placeholder="搜索图片资产标题或摘要" />
            </div>
            <button className="btn" type="button" onClick={handleSearch}>搜索</button>
          </div>
          <div className="style-boundary style-library-selection-bar">
            <label className="style-select-all">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allVisibleChecked}
                disabled={!items.length || deleting}
                onChange={toggleSelectAll}
              />
              <span>全选当前页</span>
            </label>
            <span className="style-selection-count">
              {visibleCheckedIds.length > 0 ? `已选 ${visibleCheckedIds.length} / ${items.length} 项 · 共 ${total} 项` : `当前共 ${total} 项`}
            </span>
            <div className="style-selection-actions">
              {visibleCheckedIds.length > 0 && (
                <button className="btn" type="button" disabled={deleting} onClick={clearChecked}>取消选择</button>
              )}
              <button
                className="btn btn-danger-outline"
                type="button"
                disabled={!visibleCheckedIds.length || deleting}
                onClick={() => setDeleteConfirm({ mode: "batch", ids: visibleCheckedIds.slice(0, BATCH_DELETE_MAX) })}
              >
                {visibleCheckedIds.length > 0 ? `批量删除 (${visibleCheckedIds.length})` : "批量删除"}
              </button>
            </div>
          </div>
          <div className="style-results">
            <div className="style-grid">
              {loading ? (
                <div className="style-library-loading">正在加载图片资产…</div>
              ) : items.length ? (
                items.map((item) => {
                  const isChecked = checkedIds.has(item.id);
                  return (
                    <article
                      className={`style-card ${selected?.id === item.id ? "active" : ""} ${isChecked ? "is-checked" : ""}`}
                      key={item.id}
                      onClick={() => setSelected(item)}
                    >
                      <div className="style-image">
                        {imagePreview(item)}
                        <label
                          className="style-card-check"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`选择 ${item.title}`}
                            checked={isChecked}
                            disabled={deleting}
                            onChange={() => toggleCheck(item.id)}
                          />
                        </label>
                        <span className={`badge ${statusClass(item.status)}`}>{statusLabel(item.status)}</span>
                      </div>
                      <div className="style-card-body">
                        <div className="style-card-title">{item.title}</div>
                        <p className="style-card-summary">{item.summary || stageLabel(item.stage)}</p>
                        <div className="style-card-meta"><span>{resourceLabel(item)}</span><span>{item.resourceVersionId.slice(0, 8)}</span></div>
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="style-library-empty">
                  <strong>没有匹配的图片资产</strong>
                  <p>可以调整搜索词、状态或左侧筛选条件。</p>
                </div>
              )}
            </div>
          </div>
          <footer className="style-library-pagination" aria-label="图片资产分页">
            <span className="style-pagination-info">
              第 {page} / {totalPages} 页 · 共 {total} 项
            </span>
            <div className="style-pagination-actions">
              <button
                className="btn"
                type="button"
                disabled={loading || deleting || page <= 1}
                onClick={() => handlePageChange(page - 1)}
              >
                上一页
              </button>
              <button
                className="btn"
                type="button"
                disabled={loading || deleting || page >= totalPages}
                onClick={() => handlePageChange(page + 1)}
              >
                下一页
              </button>
            </div>
          </footer>
        </section>

        <aside className="panel right style-inspector">
          <header className="panel-header">
            <strong className="panel-title">图片详情</strong>
            {selected && <button className="icon-btn" type="button" aria-label="清除详情" onClick={() => setSelected(null)}><Icon name="x" /></button>}
          </header>
          {selected ? (
            <div className="inspector-body">
              <figure className="style-detail-image">
                {selected.previewUrl ? <img src={selected.previewUrl} alt={selected.title} /> : imagePreview(selected)}
              </figure>
              <section className="inspector-section style-overview">
                <span className={`badge ${statusClass(selected.status)}`}>{statusLabel(selected.status)}</span>
                <h2>{selected.title}</h2>
                <p>{selected.summary || stageLabel(selected.stage)}</p>
                <div className="resource-card-meta">
                  <span className="badge">{resourceLabel(selected)}</span>
                  <span className="badge">{selected.stage === "aplus_image" ? "A+详情" : stageLabel(selected.stage)}</span>
                  {selected.source?.generatedBy === "image_editor" && <span className="badge">编辑生成</span>}
                </div>
              </section>
              <section className="inspector-section">
                <h3>资产信息</h3>
                <dl className="definition-list">
                  <dt>资源 ID</dt><dd className="mono">{selected.id}</dd>
                  <dt>版本</dt><dd>{selected.resourceVersionId}</dd>
                  <dt>来源</dt>
                  <dd className="mono">
                    {[sourceOriginLabel(selected), selected.source?.objectKey ?? selected.source?.code].filter(Boolean).join(" · ") || "工作台业务对象"}
                  </dd>
                  <dt>更新时间</dt><dd>{new Date(selected.updatedAt).toLocaleString("zh-CN")}</dd>
                </dl>
              </section>
              <section className="inspector-section">
                <h3>提示词快照</h3>
                <div className="style-library-prompt-entry">
                  <div>
                    <strong>已保存提示词快照</strong>
                    <span>{promptTextFor(selected).slice(0, 72)}{promptTextFor(selected).length > 72 ? "…" : ""}</span>
                  </div>
                  <button className="btn" type="button" onClick={() => setPromptModal(selected)}>查看完整提示词快照</button>
                </div>
              </section>
              <section className="inspector-section">
                <h3>快捷复用</h3>
                <div className="style-library-actions">
                  {selected.previewUrl && (
                    <a className="btn" href={selected.previewUrl} download={`${selected.title}.png`}>下载图片</a>
                  )}
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(promptTextFor(selected)).catch(() => undefined);
                      notify("已复制提示词，正在前往创建新方案");
                      navigate(`/suites/new?prefillName=${encodeURIComponent(`${selected.title} · 复用方案`)}`);
                    }}
                  >
                    复制提示词并新建方案
                  </button>
                </div>
              </section>
              <section className="inspector-section">
                <h3>生成参数</h3>
                <dl className="definition-list">
                  <dt>图片比例</dt><dd>{ratioFor(selected)}</dd>
                  <dt>图片尺寸</dt><dd>{dimensionsFor(selected)}</dd>
                  <dt>清晰度</dt><dd>{promptSnapshotValue(selected, "quality")}</dd>
                  <dt>模型</dt><dd>{promptSnapshotValue(selected, "model")}</dd>
                </dl>
              </section>
              <section className="inspector-section">
                <h3>资产管理</h3>
                <div className="style-library-actions">
                  {selected.resourceType === "reverse_reference_asset" && (
                    <>
                      <button className="btn btn-primary" type="button" disabled={selected.status === "published" || deleting} onClick={() => changeStatus(selected, "published")}>发布</button>
                      <button className="btn" type="button" disabled={selected.status === "archived" || deleting} onClick={() => changeStatus(selected, "archived")}>归档</button>
                    </>
                  )}
                  <button
                    className="btn btn-danger-outline"
                    type="button"
                    disabled={deleting}
                    onClick={() => setDeleteConfirm({ mode: "single", resource: selected })}
                  >
                    删除图片
                  </button>
                </div>
              </section>
            </div>
          ) : (
            <div className="style-library-inspector-empty">
              <Icon name="image" />
              <strong>选择一张图片资产</strong>
              <span>从中间列表选择图片，查看生成参数与提示词快照。</span>
            </div>
          )}
        </aside>
      </main>
      {promptModal && (
        <Modal
          backdropClassName="style-library-modal-backdrop"
          className="style-library-prompt-modal"
          onClose={() => setPromptModal(null)}
          aria-labelledby="image-assets-prompt-title"
        >
          <header>
            <div>
              <span className="style-library-modal-kicker">PROMPT SNAPSHOT</span>
              <h2 id="image-assets-prompt-title">{promptModal.title}</h2>
              <p>{resourceLabel(promptModal)} · {stageLabel(promptModal.stage)}</p>
            </div>
            <button className="icon-btn" type="button" aria-label="关闭提示词" onClick={() => setPromptModal(null)}><Icon name="x" /></button>
          </header>
          <div className="style-library-modal-body">
            <div className="style-library-modal-image">{promptModal.previewUrl ? <img src={promptModal.previewUrl} alt={promptModal.title} /> : imagePreview(promptModal)}</div>
            <div className="style-library-modal-content">
              <div className="style-library-modal-meta">
                <span><b>比例</b>{ratioFor(promptModal)}</span>
                <span><b>尺寸</b>{dimensionsFor(promptModal)}</span>
                <span><b>清晰度</b>{promptSnapshotValue(promptModal, "quality")}</span>
                <span><b>模型</b>{promptSnapshotValue(promptModal, "model")}</span>
              </div>
              <div className="style-library-modal-prompt-head"><strong>提示词内容</strong><span>历史快照，只读</span></div>
              <pre className="style-library-modal-prompt">{promptTextFor(promptModal)}</pre>
            </div>
          </div>
        </Modal>
      )}
      {deleteConfirm && (
        <ConfirmDialog
          eyebrow="DELETE ASSETS"
          titleId="image-assets-delete-title"
          title={deleteConfirm.mode === "single"
            ? `确认删除「${deleteConfirm.resource.title}」？`
            : `确认删除已选的 ${deleteConfirm.ids.length} 张图片？`}
          danger
          loading={deleting}
          closeLabel="关闭删除确认"
          confirmLabel={deleting ? "删除中…" : "确认删除"}
          onClose={() => setDeleteConfirm(null)}
          onConfirm={executeDelete}
        >
          删除后将从图片资源库和资源选择弹窗中移除；删除后不会影响已生成的任务和历史记录。
        </ConfirmDialog>
      )}
      {error && <div className="suite-toast show" role="alert">{error}</div>}
    </AppShell>
  );
}
