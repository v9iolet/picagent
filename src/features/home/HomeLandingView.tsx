import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  productCardsApi,
  productOnboardingApi,
  type ApiProductCardSummary,
  type ApiProductOnboardingSession,
  type ApiProductOnboardingSessionSummary,
} from "../../api/client";
import { AppShell } from "../../components/AppShell";
import { InfoTip } from "../../components/ui/InfoTip";
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
  { key: "suite", title: "商品套图", to: "/create/suite", icon: "grid" },
  { key: "replica", title: "爆品图复刻", to: "/create/replica", icon: "compare" },
  { key: "aplus", title: "生成 A+", to: "/create/aplus", icon: "layers" },
  { key: "canvas", title: "生图画布", to: "/create/canvas", icon: "columns" },
  { key: "products", title: "商品库", to: "/products", icon: "box" },
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
  const [activeTab, setActiveTab] = useState<"recent" | "drafts">("recent");
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
    if (draftSessions.length === 0 && activeTab === "drafts") {
      setActiveTab("recent");
    }
  }, [draftSessions.length, activeTab]);

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
      statusText={creating ? "提取中…" : loadingLists ? "正在同步…" : "实时已同步"}
      statusTone={creating || loadingLists ? "running" : createError || listError ? "error" : "pass"}
    >
      <main className="home-landing">
        {/* Centered Hero: Title + InfoTip + Single-layer Composer + Compact Quick Tools */}
        <section className="home-hero-block" aria-label="新品信息建档">
          <div className="home-title-row">
            <h1>新品信息建档</h1>
            <InfoTip
              title="建档说明"
              label="建档说明"
              align="center"
              content="输入新品参数与卖点，或附带供应商参考图（最多 6 张）与 .txt 资料（单次最多 3 个、单个 ≤200KB），系统自动提取 6 项必填商品事实并合并追问缺项；仅用于商品建档入库，不直接生图。"
            />
          </div>

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
            placeholder="输入商品名称、核心卖点或规格参数，点击左下角 ＋ 可附带参考图与 .txt 资料…"
            submitLabel="开始建档"
            sendingLabel="提取中…"
          />

          {createError && (
            <div className="home-inline-alert" role="alert">
              <Icon name="alert" />
              <div className="home-inline-alert-text">
                <ModelSettingsMessage message={createError} />
              </div>
              <button
                type="button"
                className="btn btn-sm home-inline-retry"
                disabled={creating}
                onClick={() => void handleStartOnboarding()}
              >
                重试
              </button>
            </div>
          )}

          <nav className="home-quick-row" aria-label="快捷入口">
            {QUICK_ENTRIES.map((entry) => (
              <a
                key={entry.key}
                className="home-quick-pill"
                href={entry.to}
                onClick={linkTo(entry.to)}
                data-quick-entry={entry.key}
              >
                <span className="home-quick-left">
                  <Icon name={entry.icon} />
                  <span>{entry.title}</span>
                </span>
                <span className="home-quick-arrow" aria-hidden="true">
                  <Icon name="arrow-right" />
                </span>
              </a>
            ))}
          </nav>
        </section>

        {listError && (
          <div className="home-lower-section">
            <div className="home-inline-alert" role="alert">
              <Icon name="alert" />
              <div className="home-inline-alert-text">{listError}</div>
              <button
                type="button"
                className="btn btn-sm home-inline-retry"
                onClick={() => setReloadTick((n) => n + 1)}
              >
                重试
              </button>
            </div>
          </div>
        )}

        {/* Unified Lower Section: Segmented Switch */}
        <section className="home-lower-section" aria-label="商品卡与建档草稿">
          <div className="home-lower-header">
            <div className="home-segmented" role="tablist" aria-label="首页资产切换">
              <button
                type="button"
                role="tab"
                className={activeTab === "recent" ? "is-active" : ""}
                aria-selected={activeTab === "recent"}
                data-home-tab="recent"
                onClick={() => setActiveTab("recent")}
              >
                {recentCards.length > 0 ? `最近商品卡 (${recentCards.length})` : "最近商品卡"}
              </button>
              {draftSessions.length > 0 && (
                <button
                  type="button"
                  role="tab"
                  className={activeTab === "drafts" ? "is-active" : ""}
                  aria-selected={activeTab === "drafts"}
                  data-home-tab="drafts"
                  onClick={() => setActiveTab("drafts")}
                >
                  未完成建档草稿 ({draftSessions.length})
                </button>
              )}
            </div>

            <a className="home-view-all-link" href="/products" onClick={linkTo("/products")}>
              <span>查看全部</span>
              <Icon name="arrow-right" />
            </a>
          </div>

          {activeTab === "recent" ? (
            loadingLists && recentCards.length === 0 ? (
              <p className="home-empty-line" role="status">
                正在加载最近商品卡…
              </p>
            ) : recentCards.length === 0 ? (
              <p className="home-empty-line">
                暂无已入库商品卡，在上方输入新品资料或上传参考图即可开始建档。
              </p>
            ) : (
              <div className="home-cards-grid" role="tabpanel" aria-label="最近商品卡">
                {recentCards.map((card) => (
                  <article
                    key={card.id}
                    className="home-recent-card"
                    data-recent-card-id={card.id}
                  >
                    <div
                      className="home-card-top"
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
                      <div className="home-card-meta">
                        <h3 className="home-card-title" title={card.name}>
                          {card.name}
                        </h3>
                        {card.sellingPoints.length > 0 && (
                          <ul className="home-card-points">
                            {card.sellingPoints.slice(0, 2).map((point, index) => (
                              <li key={`${card.id}-sp-${index}`} title={point}>
                                {point}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    <div className="home-card-foot">
                      <span className="home-card-time">{formatShortDateTime(card.updatedAt)}</span>
                      <div className="home-card-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            navigate(`/create/suite?productCardId=${encodeURIComponent(card.id)}`)
                          }
                        >
                          去套图
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            navigate(`/create/replica?productCardId=${encodeURIComponent(card.id)}`)
                          }
                        >
                          去复刻
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            navigate(`/create/aplus?productCardId=${encodeURIComponent(card.id)}`)
                          }
                        >
                          生成 A+
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )
          ) : (
            <div className="home-cards-grid" role="tabpanel" aria-label="未完成建档草稿">
              {draftSessions.map((draft) => {
                const missingCount = draft.missingRequiredFields.length;
                return (
                  <article
                    key={draft.id}
                    className="home-draft-card"
                    data-draft-session-id={draft.id}
                  >
                    <div
                      className="home-card-top"
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
                      <div className="home-card-meta">
                        <h3 className="home-card-title" title={draft.title}>
                          {draft.title}
                        </h3>
                        <span className={`home-draft-badge ${missingCount === 0 ? "is-done" : ""}`}>
                          <i aria-hidden="true" />
                          <span>
                            {missingCount > 0
                              ? `待补 ${missingCount} 项必填`
                              : "6 项必填已齐 · 待保存"}
                            {draft.supplierImageCount > 0
                              ? ` · ${draft.supplierImageCount} 张参考图`
                              : ""}
                          </span>
                        </span>
                      </div>
                    </div>

                    <div className="home-card-foot">
                      <span className="home-card-time">
                        更新于 {formatShortDateTime(draft.updatedAt)}
                      </span>
                      <div className="home-card-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => navigate(`/?session=${encodeURIComponent(draft.id)}`)}
                        >
                          继续建档
                        </button>
                        <button
                          type="button"
                          className="icon-btn home-icon-danger-btn"
                          aria-label={`删除草稿 ${draft.title}`}
                          title="删除草稿"
                          onClick={() => setDeleteTarget(draft)}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
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
                  className="btn btn-danger"
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
