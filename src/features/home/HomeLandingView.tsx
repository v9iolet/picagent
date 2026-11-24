import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  productCardsApi,
  productOnboardingApi,
  type ApiProductCardSummary,
  type ApiProductOnboardingSession,
  type ApiProductOnboardingSessionSummary,
} from "../../api/client";
import { AppShell } from "../../components/AppShell";
import { Icon, ModelSettingsMessage } from "../../pages/shared";
import {
  toCreateSupplierImagePayloads,
  type ProductCardSupplierImageDraft,
} from "../products/ProductCardEditorForm";
import { OnboardingComposer } from "./OnboardingComposer";
import {
  formatShortDateTime,
  type PendingTxtAttachment,
} from "./onboarding-attachments";

const QUICK_ENTRIES = [
  {
    key: "suite",
    title: "商品套图",
    description: "上传实拍原图，自动规划并生成主图、卖点图、场景图与上架文案",
    to: "/create/suite",
    icon: "sparkles",
    tone: "blue",
  },
  {
    key: "replica",
    title: "爆品图复刻",
    description: "参考爆品参考图结构与风格，快速复刻同款高转化视觉图",
    to: "/create/replica",
    icon: "compare",
    tone: "indigo",
  },
  {
    key: "canvas",
    title: "生图画布",
    description: "在自由画布中编排多节点生图任务、细调提示词与局部重绘",
    to: "/create/canvas",
    icon: "columns",
    tone: "teal",
  },
  {
    key: "products",
    title: "商品库",
    description: "检索、编辑、归档已入库商品信息卡与供应商参考图资产",
    to: "/products",
    icon: "box",
    tone: "amber",
  },
] as const;

export function HomeLandingView({
  navigate,
  onSessionCreated,
}: {
  navigate: (to: string, options?: { replace?: boolean }) => void;
  onSessionCreated: (session: ApiProductOnboardingSession) => void;
}) {
  const [message, setMessage] = useState("");
  const [pendingImages, setPendingImages] = useState<ProductCardSupplierImageDraft[]>([]);
  const [pendingTxtFiles, setPendingTxtFiles] = useState<PendingTxtAttachment[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const [draftSessions, setDraftSessions] = useState<ApiProductOnboardingSessionSummary[]>([]);
  const [recentCards, setRecentCards] = useState<ApiProductCardSummary[]>([]);
  const [loadingLists, setLoadingLists] = useState(true);
  const [listError, setListError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);

  const [deleteTarget, setDeleteTarget] = useState<ApiProductOnboardingSessionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadSeqRef = useRef(0);

  useEffect(() => {
    let active = true;
    const seq = ++loadSeqRef.current;
    setLoadingLists(true);
    setListError("");
    void Promise.all([
      productOnboardingApi.list({ status: "draft", limit: 20 }),
      productCardsApi.list({ status: "published", limit: 8 }),
    ])
      .then(([draftRes, cardsRes]) => {
        if (!active || seq !== loadSeqRef.current) return;
        setDraftSessions(draftRes.items);
        setRecentCards(cardsRes.items);
      })
      .catch((cause) => {
        if (!active || seq !== loadSeqRef.current) return;
        setListError(cause instanceof Error ? cause.message : "首页数据加载失败，请重试");
      })
      .finally(() => {
        if (active && seq === loadSeqRef.current) setLoadingLists(false);
      });
    return () => {
      active = false;
    };
  }, [reloadTick]);

  useEffect(() => {
    if (!deleteTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) setDeleteTarget(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteTarget, deleting]);

  const linkTo = (to: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };

  const handleStartOnboarding = async () => {
    if (creating) return;
    const trimmed = message.trim();
    if (!trimmed && pendingImages.length === 0 && pendingTxtFiles.length === 0) return;

    setCreating(true);
    setCreateError("");
    try {
      const created = await productOnboardingApi.createSession({
        ...(trimmed ? { message: trimmed } : {}),
        ...(pendingTxtFiles.length > 0
          ? {
              txtFiles: pendingTxtFiles.map((txt) => ({
                filename: txt.filename,
                bytesBase64: txt.bytesBase64,
              })),
            }
          : {}),
        ...(pendingImages.length > 0
          ? { supplierImages: toCreateSupplierImagePayloads(pendingImages) }
          : {}),
      });
      onSessionCreated(created);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "发起建档对话失败，请重试");
    } finally {
      setCreating(false);
    }
  };

  const handleConfirmDeleteDraft = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setListError("");
    try {
      await productOnboardingApi.deleteSession(deleteTarget.id);
      setDraftSessions((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (cause) {
      setDeleteTarget(null);
      setListError(cause instanceof Error ? cause.message : "删除建档草稿失败，请重试");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AppShell
      activeNav="home"
      navigate={navigate}
      crumbs={[{ label: "首页" }]}
      statusText={creating ? "建档分析中…" : loadingLists ? "正在同步…" : "实时已同步"}
      statusTone={creating || loadingLists ? "running" : createError || listError ? "error" : "pass"}
    >
      <main className="home-landing">
        {/* Top centered Agent hero card */}
        <section className="home-hero" aria-label="新品商品信息建档">
          <div className="home-hero-inner">
            <div className="home-hero-badge">
              <Icon name="sparkles" />
              <span>商品建档 Agent</span>
            </div>
            <h1>新品商品信息建档</h1>
            <p className="home-hero-subtitle">
              输入新品参数与卖点，或上传供应商 <code>.txt</code> 说明与参考图，AI 自动提取结构化商品信息卡并合并追问缺失必填项；仅用于商品建档入库，不直接生图。
            </p>

            <OnboardingComposer
              variant="hero"
              message={message}
              onMessageChange={setMessage}
              pendingImages={pendingImages}
              onPendingImagesChange={setPendingImages}
              pendingTxtFiles={pendingTxtFiles}
              onPendingTxtFilesChange={setPendingTxtFiles}
              sending={creating}
              onSubmit={handleStartOnboarding}
              ariaLabel="新品商品信息输入"
              placeholder="粘贴商品名称、核心卖点、规格尺寸重量、材质工艺、适用人群场景或包装清单，也可直接附带 .txt 文件与供应商参考图开始建档…"
              submitLabel="开始建档"
              sendingLabel="正在分析建档…"
            />

            {createError && (
              <div className="home-inline-alert" role="alert">
                <Icon name="alert" />
                <div className="home-inline-alert-text">
                  <ModelSettingsMessage message={createError} />
                </div>
                <button
                  type="button"
                  className="btn home-inline-retry"
                  disabled={creating}
                  onClick={() => void handleStartOnboarding()}
                >
                  重试
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Middle quick entry cards */}
        <section className="home-section" aria-label="创作功能快捷入口">
          <div className="home-section-head">
            <div>
              <h2>快捷创作入口</h2>
              <p>从任意创作工具开始，或直接进入商品库管理已有商品卡</p>
            </div>
          </div>
          <div className="home-quick-grid">
            {QUICK_ENTRIES.map((entry) => (
              <a
                key={entry.key}
                className={`home-quick-card is-${entry.tone}`}
                href={entry.to}
                onClick={linkTo(entry.to)}
                data-quick-entry={entry.key}
              >
                <span className="home-quick-icon">
                  <Icon name={entry.icon} />
                </span>
                <div className="home-quick-body">
                  <div className="home-quick-title-row">
                    <strong>{entry.title}</strong>
                    <Icon name="arrow-right" />
                  </div>
                  <p>{entry.description}</p>
                </div>
              </a>
            ))}
          </div>
        </section>

        {listError && (
          <div className="home-section">
            <div className="home-inline-alert" role="alert">
              <Icon name="alert" />
              <div className="home-inline-alert-text">{listError}</div>
              <button
                type="button"
                className="btn home-inline-retry"
                onClick={() => setReloadTick((n) => n + 1)}
              >
                重试
              </button>
            </div>
          </div>
        )}

        {/* Unfinished onboarding drafts */}
        {draftSessions.length > 0 && (
          <section className="home-section" aria-label="未完成建档草稿">
            <div className="home-section-head">
              <div>
                <h2>未完成建档草稿</h2>
                <p>上次中断的新品建档会话，点击即可恢复双栏继续对话与补全</p>
              </div>
              <span className="badge">{draftSessions.length} 个草稿</span>
            </div>
            <div className="home-draft-grid">
              {draftSessions.map((draft) => {
                const missingCount = draft.missingRequiredFields.length;
                return (
                  <article
                    key={draft.id}
                    className="home-draft-card"
                    data-draft-session-id={draft.id}
                  >
                    <div
                      className="home-draft-main"
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/?session=${encodeURIComponent(draft.id)}`)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          navigate(`/?session=${encodeURIComponent(draft.id)}`);
                        }
                      }}
                    >
                      <div className="home-card-thumb">
                        {draft.coverThumbnailUrl ? (
                          <img src={draft.coverThumbnailUrl} alt={draft.title} loading="lazy" />
                        ) : (
                          <span className="home-card-thumb-empty">
                            <Icon name="message" />
                          </span>
                        )}
                      </div>
                      <div className="home-draft-info">
                        <h3>{draft.title}</h3>
                        <div className="home-draft-badges">
                          <span
                            className={`home-pill ${missingCount > 0 ? "is-warn" : "is-pass"}`}
                          >
                            {missingCount > 0 ? `待补 ${missingCount} 项必填` : "6 项必填已齐 · 待保存"}
                          </span>
                          {draft.supplierImageCount > 0 && (
                            <span className="home-pill">{draft.supplierImageCount} 张参考图</span>
                          )}
                        </div>
                        <span className="home-card-time">
                          更新于 {formatShortDateTime(draft.updatedAt)}
                        </span>
                      </div>
                    </div>
                    <div className="home-draft-actions">
                      <button
                        type="button"
                        className="btn home-draft-resume-btn"
                        onClick={() => navigate(`/?session=${encodeURIComponent(draft.id)}`)}
                      >
                        继续建档
                      </button>
                      <button
                        type="button"
                        className="home-icon-danger-btn"
                        aria-label={`删除草稿 ${draft.title}`}
                        title="删除草稿"
                        onClick={() => setDeleteTarget(draft)}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* Recent published product cards */}
        <section className="home-section" aria-label="最近商品信息卡">
          <div className="home-section-head">
            <div>
              <h2>最近商品信息卡</h2>
              <p>已入库的在用商品信息卡，可直接带入商品套图或爆品图复刻</p>
            </div>
            <a className="home-view-all-link" href="/products" onClick={linkTo("/products")}>
              <span>查看全部</span>
              <Icon name="arrow-right" />
            </a>
          </div>

          {loadingLists && recentCards.length === 0 ? (
            <div className="home-empty-box" role="status">
              正在加载最近商品信息卡…
            </div>
          ) : recentCards.length === 0 ? (
            <div className="home-empty-box">
              <Icon name="box" />
              <strong>暂无已入库商品信息卡</strong>
              <p>在上方输入新品资料或上传供应商文件即可开始建档，也可前往商品库手动新建。</p>
            </div>
          ) : (
            <div className="home-recent-grid">
              {recentCards.map((card) => (
                <article
                  key={card.id}
                  className="home-recent-card"
                  data-recent-card-id={card.id}
                >
                  <div
                    className="home-recent-card-top"
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/products?selected=${encodeURIComponent(card.id)}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigate(`/products?selected=${encodeURIComponent(card.id)}`);
                      }
                    }}
                  >
                    <div className="home-card-thumb">
                      {card.coverThumbnailUrl ? (
                        <img src={card.coverThumbnailUrl} alt={card.name} loading="lazy" />
                      ) : (
                        <span className="home-card-thumb-empty">
                          <Icon name="box" />
                        </span>
                      )}
                    </div>
                    <div className="home-recent-card-head">
                      <h3>{card.name}</h3>
                    </div>
                  </div>

                  {card.sellingPoints.length > 0 && (
                    <ul className="home-recent-points">
                      {card.sellingPoints.slice(0, 2).map((point, index) => (
                        <li key={`${card.id}-sp-${index}`} title={point}>
                          {point}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="home-recent-card-foot">
                    <span className="home-card-time">{formatShortDateTime(card.updatedAt)}</span>
                    <div className="home-recent-card-actions">
                      <button
                        type="button"
                        className="product-card-quick-btn"
                        onClick={() =>
                          navigate(`/create/suite?productCardId=${encodeURIComponent(card.id)}`)
                        }
                      >
                        去生成套图
                      </button>
                      <button
                        type="button"
                        className="product-card-quick-btn"
                        onClick={() =>
                          navigate(`/create/replica?productCardId=${encodeURIComponent(card.id)}`)
                        }
                      >
                        去爆品图复刻
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {deleteTarget && (
          <div
            className="home-modal-backdrop"
            role="presentation"
            onClick={() => {
              if (!deleting) setDeleteTarget(null);
            }}
          >
            <div
              className="home-confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-label="确认删除建档草稿"
              onClick={(event) => event.stopPropagation()}
            >
              <h3>删除未完成建档草稿</h3>
              <p>
                确认删除「{deleteTarget.title}」及其对话记录与草稿供应商图？此操作不可撤销。
              </p>
              <div className="home-confirm-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={deleting}
                  onClick={() => setDeleteTarget(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn home-danger-btn"
                  disabled={deleting}
                  onClick={() => void handleConfirmDeleteDraft()}
                >
                  {deleting ? "删除中…" : "确认删除"}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </AppShell>
  );
}
