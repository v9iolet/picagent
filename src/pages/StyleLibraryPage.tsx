import { useEffect, useMemo, useRef, useState } from "react";
import { suiteApi, type ApiLibraryResource, type ApiLibraryResourceType, type ApiPromptTemplate, type ApiPromptTemplateCopy } from "../api/client";
import { AppShell } from "../components/AppShell";
import { Icon } from "./shared";

type ResourceFilter = "all" | ApiLibraryResourceType;
type StageFilter = "all" | ApiPromptTemplate["stage"];

const resourceLabel = (resource: ApiLibraryResource) => ({
  input_image: "商品实拍原图",
  base_image: "白底底图",
  task_image_version: "AI 生成结果",
  process_image: "过程图",
  reverse_reference_asset: "爆品图反推",
  prompt_template: "提示词模板",
}[resource.resourceType]);

const stageLabel = (stage: ApiLibraryResource["stage"]) => ({
  base_refine: "底图精修",
  plan: "计划生成",
  structure_plan: "结构规划",
  category_prompt: "类别提示词",
  task_image: "单卡创作",
  reverse_prompt: "爆品图反推",
} as Record<string, string>)[stage ?? ""] ?? "工作台资源";

const statusLabel = (status: ApiLibraryResource["status"]) => ({ draft: "草稿", published: "已发布", archived: "已归档" }[status ?? "published"] ?? "已发布");
const statusClass = (status: ApiLibraryResource["status"]) => status === "draft" ? "warn" : status === "archived" ? "risk" : "pass";

const promptTextFor = (resource: ApiLibraryResource) => {
  if (resource.resourceType === "prompt_template") return String(resource.source?.body ?? "暂无提示词正文");
  const snapshot = resource.promptSnapshot;
  if (typeof snapshot?.finalPrompt === "string" && snapshot.finalPrompt.trim()) return snapshot.finalPrompt;
  if (typeof snapshot?.prompt === "string" && snapshot.prompt.trim()) return snapshot.prompt;
  return "暂无可读提示词内容";
};

const promptSnapshotValue = (resource: ApiLibraryResource, key: string) => {
  const value = resource.promptSnapshot?.[key];
  if (typeof value === "string" || typeof value === "number") return String(value);
  const params = resource.promptSnapshot?.generationParams;
  if (params && typeof params === "object" && key in params) {
    const nested = (params as Record<string, unknown>)[key];
    if (typeof nested === "string" || typeof nested === "number") return String(nested);
  }
  return "未记录";
};

const dimensionsFor = (resource: ApiLibraryResource) => {
  const match = resource.summary.match(/(\d+)\s*[×x]\s*(\d+)/);
  return match ? `${match[1]} × ${match[2]}` : "未记录";
};

const ratioFor = (resource: ApiLibraryResource) => {
  const recorded = promptSnapshotValue(resource, "ratio");
  if (recorded !== "未记录") return recorded;
  const match = resource.summary.match(/(\d+)\s*[×x]\s*(\d+)/);
  if (!match) return "未记录";
  const width = Number(match[1]);
  const height = Number(match[2]);
  const divisor = (a: number, b: number): number => (b === 0 ? 1 : a % b === 0 ? b : divisor(b, a % b));
  const gcd = divisor(width, height);
  return `${width / gcd}:${height / gcd}`;
};

function resourcePreview(resource: ApiLibraryResource) {
  if (resource.previewUrl) return <img src={resource.previewUrl} alt={resource.title} loading="lazy" />;
  if (resource.resourceType === "prompt_template") return <div className="style-library-template-preview"><strong>{resource.title}</strong></div>;
  return <div className="style-library-no-preview"><Icon name={resource.resourceType === "process_image" ? "history" : "image"} /><span>暂无预览</span></div>;
}

export function StyleLibraryPage({ navigate }: { navigate: (to: string) => void }) {
  const [tab, setTab] = useState<"images" | "templates">("images");
  const [query, setQuery] = useState("");
  const [resourceFilter, setResourceFilter] = useState<ResourceFilter>("all");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "published" | "draft" | "archived">("published");
  const [items, setItems] = useState<ApiLibraryResource[]>([]);
  const [selected, setSelected] = useState<ApiLibraryResource | null>(null);
  const [templateVersions, setTemplateVersions] = useState<ApiPromptTemplateCopy[]>([]);
  const [activeVersionId, setActiveVersionId] = useState<string>("");
  const [templateDraft, setTemplateDraft] = useState({ name: "", body: "", userPromptTemplate: "" });
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [promptModal, setPromptModal] = useState<ApiLibraryResource | null>(null);
  const loadSequence = useRef(0);

  useEffect(() => {
    const previous = document.title;
    document.title = "风格库 · PicAgent";
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
        resourceType: tab === "templates" ? "prompt_template" : undefined,
        stage: tab === "templates" && stageFilter !== "all" ? stageFilter : undefined,
      });
      if (sequence !== loadSequence.current) return;
      const visible = tab === "templates" ? result.items : result.items.filter((item) => item.resourceType !== "prompt_template");
      setItems(visible);
      setSelected((current) => visible.find((item) => item.id === current?.id) ?? visible[0] ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "资源加载失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load().catch(() => undefined); }, [tab, statusFilter, stageFilter]);
  useEffect(() => {
    if (!promptModal) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setPromptModal(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [promptModal]);

  const reloadTemplateVersions = async (templateId: string, preferredVersionId?: string) => {
    const versions = await suiteApi.listPromptTemplateVersions(templateId);
    setTemplateVersions(versions);
    const chosen = versions.find((v) => v.templateVersionId === preferredVersionId) ?? versions[0] ?? null;
    if (chosen) {
      setActiveVersionId(chosen.templateVersionId);
      setTemplateDraft({ name: chosen.name, body: chosen.body, userPromptTemplate: chosen.userPromptTemplate });
    } else {
      setActiveVersionId("");
    }
  };

  useEffect(() => {
    const templateId = selected?.resourceType === "prompt_template" && typeof selected.source?.templateId === "string"
      ? selected.source.templateId
      : null;
    if (!templateId) {
      setTemplateVersions([]);
      setActiveVersionId("");
      return;
    }
    reloadTemplateVersions(templateId, selected?.templateVersionId ?? undefined).catch(() => setTemplateVersions([]));
  }, [selected?.id]);

  const activeTemplateVersion = useMemo(
    () => templateVersions.find((item) => item.templateVersionId === activeVersionId) ?? null,
    [templateVersions, activeVersionId],
  );

  const filtered = useMemo(() => items.filter((item) => {
    if (tab === "images" && resourceFilter !== "all" && item.resourceType !== resourceFilter) return false;
    return true;
  }), [items, resourceFilter, tab]);

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

  const selectTemplateVersion = (version: ApiPromptTemplateCopy) => {
    setActiveVersionId(version.templateVersionId);
    setTemplateDraft({ name: version.name, body: version.body, userPromptTemplate: version.userPromptTemplate });
  };

  const selectedTemplateId = selected?.resourceType === "prompt_template" && typeof selected.source?.templateId === "string"
    ? selected.source.templateId
    : null;

  const runTemplateMutation = async (
    action: (templateId: string) => Promise<{ message: string; preferredVersionId?: string; reloadList?: boolean }>,
    fallbackError: string,
  ) => {
    if (!selectedTemplateId) return;
    setSavingTemplate(true);
    setError("");
    try {
      const outcome = await action(selectedTemplateId);
      notify(outcome.message);
      await reloadTemplateVersions(selectedTemplateId, outcome.preferredVersionId);
      if (outcome.reloadList) await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallbackError);
    } finally {
      setSavingTemplate(false);
    }
  };

  const copyTemplate = async () => {
    const sourceVersionId = activeTemplateVersion?.templateVersionId ?? selected?.templateVersionId;
    if (!sourceVersionId) return;
    await runTemplateMutation(async () => {
      const copied = await suiteApi.copyPromptTemplateVersion(sourceVersionId);
      return { message: `已创建模板草稿 v${copied.versionNo}`, preferredVersionId: copied.templateVersionId };
    }, "复制模板失败，请重试");
  };

  const saveTemplateDraft = async () => {
    if (!activeTemplateVersion || activeTemplateVersion.status !== "draft") return;
    await runTemplateMutation(async () => {
      await suiteApi.updatePromptTemplate(activeTemplateVersion.templateVersionId, templateDraft);
      return { message: "模板草稿已保存", preferredVersionId: activeTemplateVersion.templateVersionId, reloadList: true };
    }, "保存草稿失败");
  };

  const publishTemplateVersion = async (versionId: string) => {
    await runTemplateMutation(async () => {
      await suiteApi.publishPromptTemplate(versionId);
      return { message: "模板版本已发布", preferredVersionId: versionId, reloadList: true };
    }, "发布模板失败");
  };

  const retireTemplateVersion = async (versionId: string) => {
    await runTemplateMutation(async () => {
      await suiteApi.retirePromptTemplate(versionId);
      return { message: "模板版本已下线", preferredVersionId: versionId, reloadList: true };
    }, "下线模板失败");
  };

  return (
    <AppShell
      activeNav="library"
      navigate={navigate}
      fullHeight
      crumbs={[{ label: "风格库" }, { label: tab === "images" ? "图片资产" : "提示词模板" }]}
      statusText={loading ? "正在同步资源…" : `已加载 ${filtered.length} 项`}
      statusTone={loading ? "running" : error ? "error" : "pass"}
    >
      <main className="workarea styles-layout style-library-workarea">
        <section className="panel style-filter-panel">
          <header className="panel-header">
            <div>
              <strong className="panel-title">资源筛选</strong>
              <div className="panel-subtitle">{tab === "images" ? "按图片类型与发布状态筛选" : "按执行阶段与版本状态筛选"}</div>
            </div>
            <span className="badge">{filtered.length} 项</span>
          </header>
          <div className="panel-scroll">
            <div className="style-filters">
              {tab === "images" ? (
                <div className="style-filter-group">
                  <h3>资源类型</h3>
                  {([
                    ["all", "全部图片"],
                    ["input_image", "商品实拍原图"],
                    ["base_image", "白底底图"],
                    ["task_image_version", "AI 生成结果"],
                    ["process_image", "过程图"],
                    ["reverse_reference_asset", "爆品图反推"],
                  ] as [ResourceFilter, string][]).map(([value, label]) => (
                    <label className="style-check" key={value}>
                      <input type="radio" name="resourceType" checked={resourceFilter === value} onChange={() => setResourceFilter(value)} />
                      {label}
                    </label>
                  ))}
                </div>
              ) : (
                <div className="style-filter-group">
                  <h3>执行阶段</h3>
                  {([
                    ["all", "全部阶段"],
                    ["base_refine", "底图精修"],
                    ["structure_plan", "结构规划"],
                    ["category_prompt", "类别提示词"],
                    ["plan", "计划生成"],
                    ["task_image", "单卡创作"],
                    ["reverse_prompt", "爆品图反推"],
                  ] as [StageFilter, string][]).map(([value, label]) => (
                    <label className="style-check" key={value}>
                      <input type="radio" name="templateStage" checked={stageFilter === value} onChange={() => setStageFilter(value)} />
                      {label}
                    </label>
                  ))}
                </div>
              )}
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
                <Icon name="library" />
                <p>{tab === "images" ? "图片资源来自商品生产链路；除实拍原图外，每张图片都保留对应提示词快照。" : "已发布模板不可原地修改；需复制为新草稿编辑后再发布上线。"}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="styles-center style-library-center">
          <header className="panel-header style-catalog-toolbar">
            <div>
              <strong className="panel-title">风格库</strong>
              <div className="panel-subtitle">图片资产与提示词模板统一维护，单击卡片在右侧查看详情</div>
            </div>
          </header>
          <div className="tabs style-scope-tabs" role="tablist" aria-label="资源类型">
            <button className={`tab ${tab === "images" ? "active" : ""}`} type="button" onClick={() => { setTab("images"); setResourceFilter("all"); }} role="tab" aria-selected={tab === "images"}>
              图片资产 <span className="tab-count">{tab === "images" ? filtered.length : ""}</span>
            </button>
            <button className={`tab ${tab === "templates" ? "active" : ""}`} type="button" onClick={() => { setTab("templates"); setStageFilter("all"); }} role="tab" aria-selected={tab === "templates"}>
              提示词模板 <span className="tab-count">{tab === "templates" ? filtered.length : ""}</span>
            </button>
          </div>
          <div className="style-library-toolbar">
            <div className="search-wrap">
              <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") load().catch(() => undefined); }} placeholder={tab === "images" ? "搜索图片资产" : "搜索提示词模板"} />
            </div>
            <button className="btn" type="button" onClick={() => load().catch(() => undefined)}>搜索</button>
          </div>
          <div className="style-boundary">
            <strong>当前范围</strong>
            <span>{tab === "images" ? "商品实拍原图、白底底图、AI 生成结果、过程图和爆品图反推。" : "System Prompt、User Prompt、inputSchema 和不可变版本生命周期。"}</span>
            <span className="badge pass">独立资源页</span>
          </div>
          <div className="style-results">
            <div className="style-grid">
              {loading ? (
                <div className="style-library-loading">正在加载资源…</div>
              ) : filtered.length ? (
                filtered.map((item) => (
                  <article className={`style-card ${selected?.id === item.id ? "active" : ""}`} key={item.id} onClick={() => setSelected(item)}>
                    <div className="style-image">
                      {resourcePreview(item)}
                      <span className={`badge ${statusClass(item.status)}`}>{statusLabel(item.status)}</span>
                    </div>
                    <div className="style-card-body">
                      <div className="style-card-title">{item.title}</div>
                      <p className="style-card-summary">{item.resourceType === "prompt_template" ? `${stageLabel(item.stage)} · v${String(item.source?.versionNo ?? "-")}` : item.summary || stageLabel(item.stage)}</p>
                      <div className="style-card-meta"><span>{resourceLabel(item)}</span><span>{item.resourceVersionId.slice(0, 8)}</span></div>
                    </div>
                  </article>
                ))
              ) : (
                <div className="style-library-empty">
                  <strong>没有匹配的资源</strong>
                  <p>可以调整搜索词、状态或左侧筛选条件。</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="panel right style-inspector">
          <header className="panel-header">
            <div>
              <strong className="panel-title">资源详情</strong>
              <div className="panel-subtitle">查看提示词快照和版本管理</div>
            </div>
            {selected && <button className="icon-btn" type="button" aria-label="清除详情" onClick={() => setSelected(null)}><Icon name="x" /></button>}
          </header>
          {selected ? (
            <div className="inspector-body">
              <figure className="style-detail-image">
                {selected.previewUrl ? <img src={selected.previewUrl} alt={selected.title} /> : resourcePreview(selected)}
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
                <h3>资源信息</h3>
                <dl className="definition-list">
                  <dt>资源 ID</dt><dd className="mono">{selected.id}</dd>
                  <dt>版本</dt><dd>{selected.resourceVersionId}</dd>
                  <dt>来源</dt><dd className="mono">{String(selected.source?.objectKey ?? selected.source?.code ?? "工作台业务对象")}</dd>
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
                      <strong>{selected.resourceType === "prompt_template" ? "模板正文预览" : "已保存提示词快照"}</strong>
                      <span>{promptTextFor(selected).slice(0, 72)}{promptTextFor(selected).length > 72 ? "…" : ""}</span>
                    </div>
                    <button className="btn" type="button" onClick={() => setPromptModal(selected)}>查看完整提示词快照</button>
                  </div>
                )}
              </section>
              {selected.resourceType !== "input_image" && selected.resourceType !== "prompt_template" && (
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
              {selected.resourceType === "prompt_template" && (
                <section className="inspector-section style-library-template-editor">
                  <div className="style-template-head">
                    <h3>模板版本管理</h3>
                    <button className="btn" type="button" disabled={savingTemplate} onClick={() => copyTemplate().catch(() => undefined)}>复制新草稿</button>
                  </div>
                  <div className="style-library-version-list">
                    {templateVersions.map((version) => (
                      <div className={`style-version-row ${version.templateVersionId === activeVersionId ? "is-selected" : ""}`} key={version.templateVersionId}>
                        <button type="button" className="style-version-select" onClick={() => selectTemplateVersion(version)}>
                          <span>v{version.versionNo} · {version.status === "published" ? "已发布" : version.status === "draft" ? "草稿" : "已下线"}</span>
                          <small>{version.templateVersionId.slice(0, 8)}</small>
                        </button>
                        <div className="style-version-ops">
                          {version.status === "draft" && (
                            <button className="btn btn-primary" type="button" disabled={savingTemplate} onClick={() => publishTemplateVersion(version.templateVersionId).catch(() => undefined)}>发布</button>
                          )}
                          {version.status === "published" && (
                            <button className="btn" type="button" disabled={savingTemplate} onClick={() => retireTemplateVersion(version.templateVersionId).catch(() => undefined)}>下线</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {activeTemplateVersion && (
                    <div className="style-draft-fields">
                      <label>
                        <span>模板名称</span>
                        <input className="input" disabled={activeTemplateVersion.status !== "draft" || savingTemplate} value={templateDraft.name} onChange={(event) => setTemplateDraft({ ...templateDraft, name: event.target.value })} />
                      </label>
                      <label>
                        <span>System Prompt</span>
                        <textarea className="textarea" rows={5} disabled={activeTemplateVersion.status !== "draft" || savingTemplate} value={templateDraft.body} onChange={(event) => setTemplateDraft({ ...templateDraft, body: event.target.value })} />
                      </label>
                      <label>
                        <span>User Prompt 模板</span>
                        <textarea className="textarea" rows={4} disabled={activeTemplateVersion.status !== "draft" || savingTemplate} value={templateDraft.userPromptTemplate} onChange={(event) => setTemplateDraft({ ...templateDraft, userPromptTemplate: event.target.value })} />
                      </label>
                      {activeTemplateVersion.status === "draft" ? (
                        <div className="style-library-actions">
                          <button className="btn btn-primary" type="button" disabled={savingTemplate} onClick={() => saveTemplateDraft().catch(() => undefined)}>{savingTemplate ? "保存中…" : "保存草稿"}</button>
                          <button className="btn" type="button" disabled={savingTemplate} onClick={() => publishTemplateVersion(activeTemplateVersion.templateVersionId).catch(() => undefined)}>发布此版本</button>
                        </div>
                      ) : (
                        <small className="style-readonly-hint">当前版本为只读状态，如需修改请点击上方“复制新草稿”。</small>
                      )}
                    </div>
                  )}
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
              <Icon name="library" />
              <strong>选择一项资源</strong>
              <span>从中间列表选择图片或提示词模板，查看详情和提示词。</span>
            </div>
          )}
        </aside>
      </main>
      {promptModal && (
        <div className="style-library-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPromptModal(null); }}>
          <section className="style-library-prompt-modal" role="dialog" aria-modal="true" aria-labelledby="style-library-prompt-title">
            <header>
              <div>
                <span className="style-library-modal-kicker">PROMPT SNAPSHOT</span>
                <h2 id="style-library-prompt-title">{promptModal.title}</h2>
                <p>{resourceLabel(promptModal)} · {stageLabel(promptModal.stage)}</p>
              </div>
              <button className="icon-btn" type="button" aria-label="关闭提示词" onClick={() => setPromptModal(null)}><Icon name="x" /></button>
            </header>
            <div className="style-library-modal-body">
              <div className="style-library-modal-image">{promptModal.previewUrl ? <img src={promptModal.previewUrl} alt={promptModal.title} /> : resourcePreview(promptModal)}</div>
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
