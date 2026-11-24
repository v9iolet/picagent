import { useCallback, useEffect, useMemo, useState } from "react";
import { createIdempotencyKey } from "../api/client";
import { AppShell } from "../components/AppShell";
import { Icon } from "./shared";
import "../product-reverse.css";

type Mode = "main" | "detail";
type Template = { templateVersionId: string; name: string; versionNo?: number; applicability?: Record<string, unknown> };
type PromptVersion = { id: string; prompt: string; provider?: { model: string; channel?: { channelName: string } } };
type Attempt = { id: string; status: "pending" | "running" | "succeeded" | "failed"; errorMessage?: string | null };
type Ref = {
  id: string;
  ordinal: number;
  filename: string;
  width?: number;
  height?: number;
  templateVersionId?: string | null;
  attempts: Attempt[];
  promptVersions: PromptVersion[];
  effectivePromptVersionId?: string | null;
};
type Plan = { id: string; mode: Mode; baselineReferenceId?: string | null; references: Ref[] };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const payload = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? "请求失败") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload?.data as T;
}

export function ReversePage({ planId, navigate }: { planId?: string; navigate: (to: string) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(Boolean(planId));
  const [loadError, setLoadError] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewActual, setPreviewActual] = useState(false);

  const mode: Mode = plan?.mode ?? "main";
  const selected = plan?.references.find((item) => item.id === selectedId) ?? plan?.references[0] ?? null;
  const preview = plan?.references.find((item) => item.id === previewId) ?? null;
  const promptVersion = selected?.promptVersions.find((item) => item.id === selected.effectivePromptVersionId);
  const selectedPrompt = promptVersion?.prompt ?? "";
  const stateOf = (item: Ref) => item.attempts[item.attempts.length - 1]?.status ?? "pending";
  const templateById = useMemo(
    () => new Map(templates.map((template) => [template.templateVersionId, template])),
    [templates],
  );
  const closePreview = () => { setPreviewId(null); setPreviewActual(false); };

  const loadPlan = useCallback(async (id: string, isCancelled?: () => boolean) => {
    setLoading(true);
    setLoadError("");
    setMessage("");
    setPreviewId(null);
    setPreviewActual(false);
    try {
      const next = await api<Plan>(`/api/reverse-plans/${encodeURIComponent(id)}`);
      if (isCancelled?.()) return;
      setPlan(next);
      setSelectedId((current) => current && next.references.some((item) => item.id === current) ? current : next.references[0]?.id ?? null);
    } catch (error) {
      if (isCancelled?.()) return;
      setPlan(null);
      setSelectedId(null);
      setLoadError(error instanceof Error ? error.message : "加载旧反推方案失败");
    } finally {
      if (!isCancelled?.()) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    api<Template[]>("/api/prompt-templates?stage=reverse_prompt&status=all")
      .then(setTemplates)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (planId) {
      loadPlan(planId, () => cancelled).catch(() => undefined);
    } else {
      setPlan(null);
      setSelectedId(null);
      setMessage("");
      setPreviewId(null);
      setPreviewActual(false);
      setLoading(false);
      setLoadError("");
    }
    return () => {
      cancelled = true;
    };
  }, [planId, loadPlan]);

  useEffect(() => {
    if (!previewId) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && closePreview();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [previewId]);

  const succeededCount = useMemo(
    () => (plan?.references ?? []).filter((item) =>
      item.attempts.some((attempt) => attempt.status === "succeeded")
      && item.promptVersions.some((version) => version.id === item.effectivePromptVersionId),
    ).length,
    [plan],
  );

  const openReplica = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault();
      navigate("/create/replica");
    }
  };

  const enterCanvas = async () => {
    if (!plan || importing) return;
    setImporting(true);
    try {
      const result = await api<{ suiteId: string }>(`/api/reverse-plans/${encodeURIComponent(plan.id)}/canvas-imports`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() },
        body: JSON.stringify({}),
      });
      navigate(`/create/canvas/${result.suiteId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入共享画布失败");
    } finally {
      setImporting(false);
    }
  };

  const archiveSelected = async () => {
    if (!plan || !selected || archiving) return;
    setArchiving(true);
    try {
      await api(`/api/reverse-plans/${encodeURIComponent(plan.id)}/references/${encodeURIComponent(selected.id)}/asset`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": createIdempotencyKey() },
      });
      setMessage("已保存为爆品图反推资产");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "资产保存失败");
    } finally {
      setArchiving(false);
    }
  };

  const copyPrompt = async () => {
    if (!selectedPrompt) return;
    try {
      await navigator.clipboard?.writeText(selectedPrompt);
      setMessage("提示词已复制");
    } catch {
      setMessage("复制失败，请手动选中复制");
    }
  };

  const selectedTemplate = selected?.templateVersionId ? templateById.get(selected.templateVersionId) : undefined;
  const isBaseline = Boolean(mode === "detail" && selected && selected.id === plan?.baselineReferenceId);

  return (
    <AppShell
      activeNav="create"
      navigate={navigate}
      fullHeight
      crumbs={[{ label: "爆品图复刻", to: "/create/replica" }, { label: "旧反推方案（只读）" }]}
      statusText={loadError || message || "旧反推方案只读查看"}
      statusTone={loadError ? "error" : "pass"}
    >
      <div className="reverse-readonly-page">
        <div className="reverse-upgrade-banner" role="status">
          <div className="reverse-upgrade-copy">
            <span className="reverse-readonly-badge">只读归档</span>
            <strong>爆品图反推已升级为爆品图复刻</strong>
            <span>当前旧方案仅支持查看参考图与提示词、复制提示词、带入画布和存为反推资产。</span>
          </div>
          <a className="reverse-upgrade-link" href="/create/replica" onClick={openReplica}>
            前往爆品图复刻
            <Icon name="arrow-right" />
          </a>
        </div>

        <div className="reverse-layout">
          <aside className="reverse-panel left">
            <div className="reverse-panel-scroll">
              <div className="reverse-panel-head">
                <h1>爆品图反推</h1>
                <p>旧反推方案已转为只读模式，不再支持新增参考图、重新反推或修改提示词。</p>
              </div>
              <section className="reverse-left-section">
                <div className="reverse-section-label"><strong>方案信息</strong><span>只读</span></div>
                <dl className="reverse-readonly-kv">
                  <div>
                    <dt>反推类型</dt>
                    <dd>{plan ? (mode === "main" ? "主图反推" : "详情图反推") : "—"}</dd>
                  </div>
                  <div>
                    <dt>参考图数</dt>
                    <dd>{plan?.references.length ?? 0} 张</dd>
                  </div>
                  <div>
                    <dt>可用提示词</dt>
                    <dd>{succeededCount} 条</dd>
                  </div>
                </dl>
                {plan && (
                  <p className="reverse-mode-note">
                    {mode === "main"
                      ? "主图反推方案：每张参考图对应一条独立版式与风格提示词。"
                      : "详情图反推方案：各张详情图独立保留提示词，支持系列色彩基准标记。"}
                  </p>
                )}
              </section>
              <section className="reverse-left-section">
                <div className="reverse-section-label"><strong>可用操作</strong><span>保留兼容</span></div>
                <div className="reverse-batch-actions">
                  <button
                    className="reverse-btn primary"
                    type="button"
                    disabled={!plan || succeededCount === 0 || importing}
                    onClick={() => enterCanvas().catch(() => undefined)}
                  >
                    <Icon name="arrow-right" />
                    {importing ? "正在带入画布…" : "带入共享画布"}
                  </button>
                  <a className="reverse-btn secondary" href="/create/replica" onClick={openReplica}>
                    <Icon name="sparkles" />
                    前往爆品图复刻
                  </a>
                </div>
                <small className="reverse-limit">如需上传参考图和产品图一键生成复刻成品图，请使用新的爆品图复刻功能。</small>
              </section>
            </div>
          </aside>

          <main className="reverse-main">
            <header className="reverse-main-head">
              <div>
                <h2>{plan ? (mode === "main" ? "主图反推（只读）" : "详情图反推（只读）") : "旧反推方案（只读）"}</h2>
                <p>点击卡片查看对应提示词，点击缩略图预览原始参考图。</p>
              </div>
              <div className="reverse-counter">
                <strong>{plan?.references.length ?? 0}</strong> 张参考图 · <strong>{succeededCount}</strong> 条提示词
              </div>
            </header>
            <div className="reverse-content">
              {!planId ? (
                <div className="reverse-readonly-empty">
                  <strong>爆品图反推已升级为爆品图复刻</strong>
                  <p>已停止新建旧反推方案，请前往爆品图复刻直接生成同款成品图。</p>
                  <a className="reverse-btn primary" href="/create/replica" onClick={openReplica}>
                    前往爆品图复刻
                    <Icon name="arrow-right" />
                  </a>
                </div>
              ) : loading ? (
                <div className="reverse-readonly-empty">
                  <strong>正在加载旧反推方案…</strong>
                </div>
              ) : loadError || !plan ? (
                <div className="reverse-readonly-empty">
                  <strong>{loadError || "未找到该反推方案"}</strong>
                  <p>旧反推方案仅支持只读查看历史记录，创建新任务请前往爆品图复刻。</p>
                  <a className="reverse-btn primary" href="/create/replica" onClick={openReplica}>
                    前往爆品图复刻
                    <Icon name="arrow-right" />
                  </a>
                </div>
              ) : plan.references.length === 0 ? (
                <div className="reverse-readonly-empty">
                  <strong>该旧反推方案暂无参考图</strong>
                  <p>当前方案为只读归档，无法继续上传参考图。</p>
                </div>
              ) : (
                <>
                  <div className="reverse-reference-head">
                    <h3>参考图列表</h3>
                    <span>点击图片查看原图 · 点击卡片查看只读提示词</span>
                  </div>
                  <section className="reverse-image-grid">
                    {plan.references.map((item) => {
                      const status = stateOf(item);
                      const template = item.templateVersionId ? templateById.get(item.templateVersionId) : undefined;
                      return (
                        <article
                          className={`reverse-image-card ${item.id === selected?.id ? "selected" : ""}`}
                          key={item.id}
                          onClick={() => setSelectedId(item.id)}
                        >
                          <div className="reverse-image-top">
                            <button
                              className="reverse-image-preview"
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setPreviewId(item.id);
                                setPreviewActual(false);
                              }}
                              aria-label={`查看原图 ${item.filename}`}
                            >
                              <img src={`/api/reverse-plans/${encodeURIComponent(plan.id)}/references/${encodeURIComponent(item.id)}/preview`} alt={item.filename} />
                              <span className="reverse-image-zoom"><Icon name="zoom-in" />查看原图</span>
                            </button>
                            <span className="reverse-image-index">{item.ordinal}</span>
                          </div>
                          <div className="reverse-image-meta">
                            <div className="reverse-image-name">{item.filename}</div>
                            <div className="reverse-image-sub">
                              {mode === "detail" && item.id === plan.baselineReferenceId ? "系列色彩基准" : "独立处理"}
                            </div>
                            <div className="reverse-readonly-template">
                              <span>反推模板</span>
                              <strong>
                                {template
                                  ? `${template.name} · v${template.versionNo ?? 1}`
                                  : item.templateVersionId
                                    ? "已关联模板"
                                    : "未选择模板"}
                              </strong>
                            </div>
                            <div className="reverse-card-status">
                              <b className={status === "succeeded" ? "done" : status === "failed" ? "failed" : status === "running" ? "running" : ""}>
                                {status === "succeeded" ? "已生成" : status === "failed" ? "失败" : status === "running" ? "生成中…" : "待反推"}
                              </b>
                              <span className="reverse-card-open">查看提示词</span>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </section>
                </>
              )}
            </div>
          </main>

          <aside className="reverse-panel right">
            <div className="reverse-panel-scroll">
              <div className="reverse-right-head">
                <h2>提示词（只读）</h2>
                <p>
                  {promptVersion?.provider
                    ? [promptVersion.provider.channel?.channelName, promptVersion.provider.model].filter(Boolean).join(" · ")
                    : "选中一张参考图后，可查看、复制提示词或保存为反推资产。"}
                </p>
              </div>
              {selected && plan ? (
                <div className="reverse-inspector">
                  <div className="reverse-inspector-info">
                    <button
                      className="reverse-inspector-thumb"
                      type="button"
                      onClick={() => { setPreviewId(selected.id); setPreviewActual(false); }}
                      aria-label={`查看原图 ${selected.filename}`}
                    >
                      <img src={`/api/reverse-plans/${encodeURIComponent(plan.id)}/references/${encodeURIComponent(selected.id)}/preview`} alt={selected.filename} />
                    </button>
                    <div>
                      <strong>参考图 {selected.ordinal}</strong>
                      <span>{selected.filename}</span>
                    </div>
                  </div>
                  <div className="reverse-summary-pills" aria-label="视觉结构与真值边界摘要">
                    <span className="reverse-pill">{mode === "main" ? "主图视觉结构" : "详情视觉结构"}</span>
                    <span className="reverse-pill">
                      {selectedTemplate
                        ? `${selectedTemplate.name} · v${selectedTemplate.versionNo ?? 1}`
                        : selected.templateVersionId
                          ? "已关联模板"
                          : "未选择模板"}
                    </span>
                    {isBaseline && <span className="reverse-pill is-highlight">系列色彩基准</span>}
                    <span className="reverse-pill is-guard">外观隔离：白底图为唯一外观真值，不迁移品牌/参数</span>
                  </div>
                  <label className="reverse-field">
                    <span>反推出的提示词（只读）</span>
                    <textarea
                      value={selectedPrompt}
                      readOnly
                      placeholder="该参考图暂无已生成的提示词"
                      spellCheck={false}
                    />
                  </label>
                  <div className="reverse-inspector-actions">
                    <button
                      className="reverse-btn secondary wide"
                      type="button"
                      disabled={!selectedPrompt}
                      onClick={() => copyPrompt().catch(() => undefined)}
                    >
                      <Icon name="copy" />
                      复制提示词
                    </button>
                    <button
                      className="reverse-btn secondary wide"
                      type="button"
                      disabled={!selected.effectivePromptVersionId || archiving}
                      onClick={() => archiveSelected().catch(() => undefined)}
                    >
                      <Icon name="library" />
                      {archiving ? "保存中…" : "保存为反推资产"}
                    </button>
                  </div>
                  <div className="reverse-source-note">
                    <strong>只读归档说明</strong>
                    当前方案为历史爆品图反推记录，提示词仅支持只读查看与复制；仍可保存为反推资产或带入共享画布继续绑定白底图出图。
                  </div>
                </div>
              ) : (
                <div className="reverse-inspector-empty">选择左侧或中间列表中的参考图后，这里会展示对应的只读提示词。</div>
              )}
            </div>
          </aside>
        </div>
      </div>

      {preview && plan && (
        <div className="reverse-lightbox" role="dialog" aria-modal="true" aria-label={`原图预览 ${preview.filename}`} onMouseDown={closePreview}>
          <div className="reverse-lightbox-panel" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong>{preview.filename}</strong>
                <span>{preview.width && preview.height ? `${preview.width} × ${preview.height}` : "原始图片"}</span>
              </div>
              <div>
                <button type="button" onClick={() => setPreviewActual((value) => !value)} title={previewActual ? "适应窗口" : "1:1 原始尺寸"}>
                  <Icon name={previewActual ? "fit" : "zoom-in"} />
                  <span>{previewActual ? "适应窗口" : "1:1"}</span>
                </button>
                <button type="button" onClick={closePreview} title="关闭" aria-label="关闭原图预览"><Icon name="x" /></button>
              </div>
            </header>
            <div className={`reverse-lightbox-stage ${previewActual ? "actual" : "fit"}`}>
              <img src={`/api/reverse-plans/${encodeURIComponent(plan.id)}/references/${encodeURIComponent(preview.id)}/preview/original`} alt={preview.filename} />
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
