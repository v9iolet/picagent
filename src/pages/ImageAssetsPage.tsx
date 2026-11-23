import { useEffect, useMemo, useRef, useState } from "react";
import { suiteApi, type ApiLibraryResource, type ApiLibraryResourceType } from "../api/client";
import { AppShell } from "../components/AppShell";
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

type ImageResourceFilter = "all" | Exclude<ApiLibraryResourceType, "prompt_template">;

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
  const [resourceFilter, setResourceFilter] = useState<ImageResourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "published" | "draft" | "archived">("published");
  const [items, setItems] = useState<ApiLibraryResource[]>([]);
  const [selected, setSelected] = useState<ApiLibraryResource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [promptModal, setPromptModal] = useState<ApiLibraryResource | null>(null);
  const loadSequence = useRef(0);

  useEffect(() => {
    const previous = document.title;
    document.title = "图片库 · PicAgent";
    return () => { document.title = previous; };
  }, []);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2400); };

  const load = async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await suiteApi.listLibraryResources({
        status: statusFilter === "all" ? undefined : statusFilter,
        query: query.trim() || undefined,
      });
      if (sequence !== loadSequence.current) return;
      const visible = result.items.filter((item) => item.resourceType !== "prompt_template");
      setItems(visible);
      setSelected((current) => visible.find((item) => item.id === current?.id) ?? visible[0] ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "图片资产加载失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load().catch(() => undefined); }, [statusFilter]);
  useEffect(() => {
    if (!promptModal) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setPromptModal(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [promptModal]);

  const filtered = useMemo(() => items.filter((item) => {
    if (resourceFilter !== "all" && item.resourceType !== resourceFilter) return false;
    return true;
  }), [items, resourceFilter]);

  const changeStatus = async (resource: ApiLibraryResource, status: "published" | "archived") => {
    try {
      const updated = await suiteApi.setLibraryResourceStatus(resource.id, status);
      setSelected(updated);
      notify(status === "published" ? "资源已发布" : "资源已归档");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "状态更新失败，请重试");
    }
  };

  return (
    <AppShell
      activeNav="assets"
      navigate={navigate}
      fullHeight
      crumbs={[{ label: "图片库" }]}
      statusText={loading ? "正在同步图片资产…" : `已加载 ${filtered.length} 项`}
      statusTone={loading ? "running" : error ? "error" : "pass"}
    >
      <main className="workarea styles-layout style-library-workarea">
        <section className="panel style-filter-panel">
          <header className="panel-header">
            <div>
              <strong className="panel-title">图片筛选</strong>
              <div className="panel-subtitle">按图片类型与发布状态筛选</div>
            </div>
            <span className="badge">{filtered.length} 项</span>
          </header>
          <div className="panel-scroll">
            <div className="style-filters">
              <div className="style-filter-group">
                <h3>资产类型</h3>
                {([
                  ["all", "全部图片"],
                  ["input_image", "商品实拍原图"],
                  ["base_image", "白底底图"],
                  ["task_image_version", "AI 生成结果"],
                  ["process_image", "过程图"],
                  ["reverse_reference_asset", "爆品图反推"],
                ] as [ImageResourceFilter, string][]).map(([value, label]) => (
                  <label className="style-check" key={value}>
                    <input type="radio" name="resourceType" checked={resourceFilter === value} onChange={() => setResourceFilter(value)} />
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
                    <input type="radio" name="resourceStatus" checked={statusFilter === value} onChange={() => setStatusFilter(value)} />
                    {label}
                  </label>
                ))}
              </div>
              <div className="style-filter-note">
                <Icon name="image" />
                <p>图片资源来自商品生产链路；除实拍原图外，每张图片都保留对应提示词快照。</p>
              </div>
            </div>
          </div>
        </section>

        <section className="styles-center style-library-center">
          <header className="panel-header style-catalog-toolbar">
            <div>
              <strong className="panel-title">图片资产</strong>
              <div className="panel-subtitle">浏览实拍原图、白底底图、AI 生成图与爆品反推资产，单击卡片在右侧查看详情</div>
            </div>
          </header>
          <div className="style-library-toolbar">
            <div className="search-wrap">
              <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") load().catch(() => undefined); }} placeholder="搜索图片资产标题或摘要" />
            </div>
            <button className="btn" type="button" onClick={() => load().catch(() => undefined)}>搜索</button>
          </div>
          <div className="style-boundary">
            <strong>当前范围</strong>
            <span>商品实拍原图、白底底图、AI 生成结果、过程图和爆品图反推。</span>
            <span className="badge pass">图片资产库</span>
          </div>
          <div className="style-results">
            <div className="style-grid">
              {loading ? (
                <div className="style-library-loading">正在加载图片资产…</div>
              ) : filtered.length ? (
                filtered.map((item) => (
                  <article className={`style-card ${selected?.id === item.id ? "active" : ""}`} key={item.id} onClick={() => setSelected(item)}>
                    <div className="style-image">
                      {imagePreview(item)}
                      <span className={`badge ${statusClass(item.status)}`}>{statusLabel(item.status)}</span>
                    </div>
                    <div className="style-card-body">
                      <div className="style-card-title">{item.title}</div>
                      <p className="style-card-summary">{item.summary || stageLabel(item.stage)}</p>
                      <div className="style-card-meta"><span>{resourceLabel(item)}</span><span>{item.resourceVersionId.slice(0, 8)}</span></div>
                    </div>
                  </article>
                ))
              ) : (
                <div className="style-library-empty">
                  <strong>没有匹配的图片资产</strong>
                  <p>可以调整搜索词、状态或左侧筛选条件。</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="panel right style-inspector">
          <header className="panel-header">
            <div>
              <strong className="panel-title">图片详情</strong>
              <div className="panel-subtitle">查看生成参数、提示词快照与快捷复用</div>
            </div>
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
                  <span className="badge">{stageLabel(selected.stage)}</span>
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
                {selected.resourceType === "input_image" ? (
                  <div className="resource-prompt-empty">
                    <strong>原始输入图不适用生成提示词</strong>
                    <p>实拍原图只作为商品事实和外观依据保存。</p>
                  </div>
                ) : (
                  <div className="style-library-prompt-entry">
                    <div>
                      <strong>已保存提示词快照</strong>
                      <span>{promptTextFor(selected).slice(0, 72)}{promptTextFor(selected).length > 72 ? "…" : ""}</span>
                    </div>
                    <button className="btn" type="button" onClick={() => setPromptModal(selected)}>查看完整提示词快照</button>
                  </div>
                )}
              </section>
              <section className="inspector-section">
                <h3>快捷复用</h3>
                <div className="style-library-actions">
                  {selected.previewUrl && (
                    <a className="btn" href={selected.previewUrl} download={`${selected.title}.png`}>下载图片</a>
                  )}
                  {selected.resourceType !== "input_image" && (
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
                  )}
                </div>
              </section>
              {selected.resourceType !== "input_image" && (
                <section className="inspector-section">
                  <h3>生成参数</h3>
                  <dl className="definition-list">
                    <dt>图片比例</dt><dd>{ratioFor(selected)}</dd>
                    <dt>图片尺寸</dt><dd>{dimensionsFor(selected)}</dd>
                    <dt>清晰度</dt><dd>{promptSnapshotValue(selected, "quality")}</dd>
                    <dt>模型</dt><dd>{promptSnapshotValue(selected, "model")}</dd>
                  </dl>
                </section>
              )}
              {selected.resourceType === "reverse_reference_asset" && (
                <section className="inspector-section">
                  <div className="style-library-actions">
                    <button className="btn btn-primary" type="button" disabled={selected.status === "published"} onClick={() => changeStatus(selected, "published")}>发布</button>
                    <button className="btn" type="button" disabled={selected.status === "archived"} onClick={() => changeStatus(selected, "archived")}>归档</button>
                  </div>
                </section>
              )}
              <div className="resource-selection">
                <Icon name="sparkles" />
                <div>
                  <strong>历史引用保持稳定</strong>
                  <span>资源版本和提示词快照会随引用一起保存，不覆盖已有请求。</span>
                </div>
              </div>
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
        <div className="style-library-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPromptModal(null); }}>
          <section className="style-library-prompt-modal" role="dialog" aria-modal="true" aria-labelledby="image-assets-prompt-title">
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
          </section>
        </div>
      )}
      {error && <div className="suite-toast show" role="alert">{error}</div>}
      {toast && <div className="suite-toast show" role="status">{toast}</div>}
    </AppShell>
  );
}
