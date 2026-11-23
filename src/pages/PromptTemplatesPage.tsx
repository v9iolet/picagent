import { useEffect, useMemo, useRef, useState } from "react";
import { suiteApi, type ApiLibraryResource, type ApiPromptTemplate, type ApiPromptTemplateCopy } from "../api/client";
import { AppShell } from "../components/AppShell";
import {
  promptTextFor,
  stageLabel,
  statusClass,
  templateStatusLabel,
  templateUsedBy,
} from "../features/library/library-helpers";
import { Icon } from "./shared";

type StageFilter = "all" | ApiPromptTemplate["stage"];
type TemplateStatusFilter = "published" | "retired" | "draft" | "all";

export function PromptTemplatesPage({ navigate }: { navigate: (to: string) => void }) {
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const [statusFilter, setStatusFilter] = useState<TemplateStatusFilter>("published");
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
    document.title = "模板库 · PicAgent";
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
        resourceType: "prompt_template",
        stage: stageFilter !== "all" ? stageFilter : undefined,
        pageSize: 100,
      });
      if (sequence !== loadSequence.current) return;
      setItems(result.items);
      setSelected((current) => {
        if (!current) return result.items[0] ?? null;
        const byId = result.items.find((item) => item.id === current.id);
        if (byId) return byId;
        const currentTemplateId = typeof current.source?.templateId === "string" ? current.source.templateId : null;
        if (currentTemplateId) {
          const byTemplateId = result.items.find((item) => item.source?.templateId === currentTemplateId);
          if (byTemplateId) return byTemplateId;
        }
        return result.items[0] ?? null;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提示词模板加载失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load().catch(() => undefined); }, [statusFilter, stageFilter]);
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

  const selectedTemplateId = typeof selected?.source?.templateId === "string" ? selected.source.templateId : null;

  useEffect(() => {
    if (!selectedTemplateId) {
      setTemplateVersions([]);
      setActiveVersionId("");
      return;
    }
    reloadTemplateVersions(selectedTemplateId, selected?.templateVersionId ?? undefined).catch(() => setTemplateVersions([]));
  }, [selected?.id, selectedTemplateId]);

  const activeTemplateVersion = useMemo(
    () => templateVersions.find((item) => item.templateVersionId === activeVersionId) ?? null,
    [templateVersions, activeVersionId],
  );

  const selectTemplateVersion = (version: ApiPromptTemplateCopy) => {
    setActiveVersionId(version.templateVersionId);
    setTemplateDraft({ name: version.name, body: version.body, userPromptTemplate: version.userPromptTemplate });
  };

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
      activeNav="templates"
      navigate={navigate}
      fullHeight
      crumbs={[{ label: "模板库" }]}
      statusText={loading ? "正在同步提示词模板…" : `已加载 ${items.length} 项`}
      statusTone={loading ? "running" : error ? "error" : "pass"}
    >
      <main className="workarea styles-layout style-library-workarea">
        <section className="panel style-filter-panel">
          <header className="panel-header">
            <div>
              <strong className="panel-title">模板筛选</strong>
              <div className="panel-subtitle">按执行阶段与版本状态筛选</div>
            </div>
            <span className="badge">{items.length} 项</span>
          </header>
          <div className="panel-scroll">
            <div className="style-filters">
              <div className="style-filter-group">
                <h3>状态</h3>
                {([
                  ["published", "在用"],
                  ["retired", "已下架"],
                  ["draft", "草稿"],
                  ["all", "全部"],
                ] as [TemplateStatusFilter, string][]).map(([value, label]) => (
                  <label className="style-check" key={value}>
                    <input type="radio" name="templateStatus" checked={statusFilter === value} onChange={() => setStatusFilter(value)} />
                    {label}
                  </label>
                ))}
              </div>
              <div className="style-filter-group">
                <h3>执行阶段</h3>
                {([
                  ["all", "全部阶段"],
                  ["structure_plan", "结构规划"],
                  ["category_prompt", "类别提示词"],
                  ["base_refine", "底图精修"],
                  ["listing_copy", "上架文案"],
                  ["replica_prompt", "爆品图复刻"],
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
              <div className="style-filter-note">
                <Icon name="files" />
                <p>已发布模板不可原地修改；需复制为新草稿编辑后再发布上线。</p>
              </div>
            </div>
          </div>
        </section>

        <section className="styles-center style-library-center">
          <header className="panel-header style-catalog-toolbar">
            <div>
              <strong className="panel-title">提示词模板</strong>
              <div className="panel-subtitle">维护各阶段的 System Prompt、User Prompt 模板与版本生命周期，单击卡片在右侧编辑</div>
            </div>
          </header>
          <div className="style-library-toolbar">
            <div className="search-wrap">
              <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") load().catch(() => undefined); }} placeholder="搜索提示词模板名称或正文" />
            </div>
            <button className="btn" type="button" onClick={() => load().catch(() => undefined)}>搜索</button>
          </div>
          <div className="style-boundary">
            <strong>当前范围</strong>
            <span>System Prompt、User Prompt、inputSchema 和不可变版本生命周期。</span>
            <span className="badge pass">提示词模板库</span>
          </div>
          <div className="style-results">
            <div className="template-list-grid">
              {loading ? (
                <div className="style-library-loading">正在加载提示词模板…</div>
              ) : items.length ? (
                items.map((item) => {
                  const usedBy = templateUsedBy(item);
                  return (
                    <article className={`template-card ${selected?.id === item.id ? "active" : ""}`} key={item.id} onClick={() => setSelected(item)}>
                      <div className="template-card-head">
                        <span className="badge">{stageLabel(item.stage)}</span>
                        <span className={`badge ${statusClass(item.status)}`}>{templateStatusLabel(item.status)}</span>
                      </div>
                      <h3 className="template-card-title">{item.title}</h3>
                      <div className="template-card-usage" aria-label="使用功能">
                        {usedBy.length > 0 ? (
                          usedBy.map((feature) => (
                            <span className="badge template-usage-badge" key={feature}>{feature}</span>
                          ))
                        ) : (
                          <span className="badge template-usage-badge is-unused">未绑定运行功能</span>
                        )}
                      </div>
                      <p className="template-card-snippet">{promptTextFor(item)}</p>
                      <div className="template-card-meta">
                        <span>v{String(item.source?.versionNo ?? "-")}</span>
                        <span className="mono">{String(item.source?.code ?? item.resourceVersionId.slice(0, 8))}</span>
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="style-library-empty">
                  <strong>没有匹配的提示词模板</strong>
                  <p>可以调整搜索词、状态或左侧执行阶段筛选条件。</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="panel right style-inspector">
          <header className="panel-header">
            <div>
              <strong className="panel-title">模板详情与版本</strong>
              <div className="panel-subtitle">查看正文、复制草稿并发布上线</div>
            </div>
            {selected && <button className="icon-btn" type="button" aria-label="清除详情" onClick={() => setSelected(null)}><Icon name="x" /></button>}
          </header>
          {selected ? (
            <div className="inspector-body">
              <section className="inspector-section style-overview">
                <div className="resource-card-meta">
                  <span className={`badge ${statusClass(selected.status)}`}>{templateStatusLabel(selected.status)}</span>
                  <span className="badge">{stageLabel(selected.stage)}</span>
                  <span className="badge">v{String(selected.source?.versionNo ?? "-")}</span>
                </div>
                <h2>{selected.title}</h2>
                <p>{selected.summary || stageLabel(selected.stage)}</p>
              </section>
              <section className="inspector-section">
                <h3>模板信息</h3>
                <dl className="definition-list">
                  <dt>使用功能</dt>
                  <dd>
                    {templateUsedBy(selected).length > 0 ? (
                      <div className="template-usage-list">
                        {templateUsedBy(selected).map((feature) => (
                          <span className="badge template-usage-badge" key={feature}>{feature}</span>
                        ))}
                      </div>
                    ) : (
                      "未绑定运行功能（历史模板）"
                    )}
                  </dd>
                  <dt>资源 ID</dt><dd className="mono">{selected.id}</dd>
                  <dt>模板代码</dt><dd className="mono">{String(selected.source?.code ?? "未记录")}</dd>
                  <dt>当前版本 ID</dt><dd className="mono">{selected.resourceVersionId}</dd>
                  <dt>更新时间</dt><dd>{new Date(selected.updatedAt).toLocaleString("zh-CN")}</dd>
                </dl>
              </section>
              <section className="inspector-section">
                <h3>正文预览</h3>
                <div className="style-library-prompt-entry">
                  <div>
                    <strong>模板正文预览</strong>
                    <span>{promptTextFor(selected).slice(0, 72)}{promptTextFor(selected).length > 72 ? "…" : ""}</span>
                  </div>
                  <button className="btn" type="button" onClick={() => setPromptModal(selected)}>查看完整正文</button>
                </div>
              </section>
              <section className="inspector-section style-library-template-editor">
                <div className="style-template-head">
                  <h3>模板版本管理</h3>
                  <button className="btn" type="button" disabled={savingTemplate} onClick={() => copyTemplate().catch(() => undefined)}>复制新草稿</button>
                </div>
                <div className="style-library-version-list">
                  {templateVersions.map((version) => (
                    <div className={`style-version-row ${version.templateVersionId === activeVersionId ? "is-selected" : ""}`} key={version.templateVersionId}>
                      <button type="button" className="style-version-select" onClick={() => selectTemplateVersion(version)}>
                        <span>v{version.versionNo} · {version.status === "published" ? "在用" : version.status === "draft" ? "草稿" : "已下架"}</span>
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
              <div className="resource-selection">
                <Icon name="sparkles" />
                <div>
                  <strong>历史引用保持稳定</strong>
                  <span>已发布模板版本不可原地改写，历史计划与任务始终以引用时的版本为准。</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="style-library-inspector-empty">
              <Icon name="files" />
              <strong>选择一个提示词模板</strong>
              <span>从中间列表选择模板，查看版本历史并管理草稿或发布版本。</span>
            </div>
          )}
        </aside>
      </main>
      {promptModal && (
        <div className="style-library-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPromptModal(null); }}>
          <section className="style-library-prompt-modal" role="dialog" aria-modal="true" aria-labelledby="template-prompt-title">
            <header>
              <div>
                <span className="style-library-modal-kicker">PROMPT TEMPLATE</span>
                <h2 id="template-prompt-title">{promptModal.title}</h2>
                <p>{stageLabel(promptModal.stage)} · v{String(promptModal.source?.versionNo ?? "-")} · {templateStatusLabel(promptModal.status)}</p>
              </div>
              <button className="icon-btn" type="button" aria-label="关闭正文预览" onClick={() => setPromptModal(null)}><Icon name="x" /></button>
            </header>
            <div className="style-library-modal-body is-template-only">
              <div className="style-library-modal-content">
                <div className="style-library-modal-prompt-head"><strong>System Prompt 正文</strong><span>当前版本快照</span></div>
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
