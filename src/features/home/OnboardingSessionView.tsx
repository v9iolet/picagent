import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  emptyProductCardFields,
  getMissingRequiredProductCardFields,
  PRODUCT_CARD_REQUIRED_FIELDS,
  type ProductCardFields,
} from "../../../shared/product-card";
import {
  productOnboardingApi,
  type ApiProductOnboardingAttachment,
  type ApiProductOnboardingSession,
} from "../../api/client";
import { AppShell } from "../../components/AppShell";
import { Icon, ModelSettingsMessage } from "../../pages/shared";
import {
  ProductCardEditorForm,
  toCreateSupplierImagePayloads,
  toUpdateSupplierImagePayloads,
  type ProductCardSupplierImageDraft,
} from "../products/ProductCardEditorForm";
import { OnboardingComposer } from "./OnboardingComposer";
import {
  formatShortDateTime,
  supplierImagesFromSession,
  type PendingTxtAttachment,
} from "./onboarding-attachments";

type DraftSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

interface ParsedAssistantBlocks {
  intro: string[];
  numberedItems: Array<{ label: string; detail: string }>;
  outro: string[];
}

function parseAssistantContent(content: string): ParsedAssistantBlocks | null {
  const lines = content.split("\n");
  const intro: string[] = [];
  const numberedItems: Array<{ label: string; detail: string }> = [];
  const outro: string[] = [];
  let state: "intro" | "list" | "outro" = "intro";

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const match = trimmed.match(/^\d+[.、]\s+(.+)$/);
    if (match && state !== "outro") {
      state = "list";
      const body = match[1];
      const colonIdx = body.search(/[：:]/);
      if (colonIdx > 0 && colonIdx <= 24) {
        numberedItems.push({
          label: body.slice(0, colonIdx),
          detail: body.slice(colonIdx),
        });
      } else {
        numberedItems.push({ label: "", detail: body });
      }
    } else if (state === "intro") {
      if (trimmed) intro.push(trimmed);
    } else {
      if (trimmed) {
        state = "outro";
        outro.push(trimmed);
      }
    }
  }

  if (numberedItems.length === 0) return null;
  return { intro, numberedItems, outro };
}

export function OnboardingSessionView({
  sessionId,
  initialSession,
  onConsumeInitialSession,
  navigate,
}: {
  sessionId: string;
  initialSession?: ApiProductOnboardingSession | null;
  onConsumeInitialSession?: () => void;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}) {
  const matchedInitial = initialSession && initialSession.id === sessionId ? initialSession : null;

  const [session, setSession] = useState<ApiProductOnboardingSession | null>(matchedInitial);
  const [loading, setLoading] = useState(!matchedInitial);
  const [loadError, setLoadError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);

  const [draftFields, setDraftFields] = useState<ProductCardFields>(() =>
    matchedInitial ? matchedInitial.draftCard : emptyProductCardFields(),
  );
  const [draftImages, setDraftImages] = useState<ProductCardSupplierImageDraft[]>(() =>
    matchedInitial ? supplierImagesFromSession(matchedInitial) : [],
  );
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>("idle");
  const [draftSaveError, setDraftSaveError] = useState("");

  const [replyText, setReplyText] = useState("");
  const [replyImages, setReplyImages] = useState<ProductCardSupplierImageDraft[]>([]);
  const [replyTxtFiles, setReplyTxtFiles] = useState<PendingTxtAttachment[]>([]);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [sendError, setSendError] = useState("");

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [expandedTxtIds, setExpandedTxtIds] = useState<Record<string, boolean>>({});

  const draftFieldsRef = useRef(draftFields);
  const draftImagesRef = useRef(draftImages);
  draftFieldsRef.current = draftFields;
  draftImagesRef.current = draftImages;

  const draftVersionRef = useRef(0);
  const savedVersionRef = useRef(0);
  const savingVersionRef = useRef(0);
  const imagesDirtyRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);
  const inFlightSaveRef = useRef<Promise<boolean> | null>(null);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const sessionStatusRef = useRef(session?.status ?? "draft");
  sessionStatusRef.current = session?.status ?? "draft";
  const initialSessionRef = useRef(initialSession);
  initialSessionRef.current = initialSession;
  const seededSessionIdRef = useRef<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (
        sessionStatusRef.current === "draft" &&
        draftVersionRef.current > Math.max(savedVersionRef.current, savingVersionRef.current)
      ) {
        const activeSessionId = sessionIdRef.current;
        const fields = draftFieldsRef.current;
        const images = draftImagesRef.current;
        const includeImages = imagesDirtyRef.current;
        savingVersionRef.current = draftVersionRef.current;
        void productOnboardingApi
          .saveDraft(activeSessionId, {
            draftCard: fields,
            ...(includeImages
              ? { supplierImages: toUpdateSupplierImagePayloads(images) }
              : {}),
          })
          .catch(() => undefined);
      }
    };
  }, []);

  const hydrateFromSession = useCallback((loaded: ApiProductOnboardingSession) => {
    setSession(loaded);
    setDraftFields(loaded.draftCard);
    setDraftImages(supplierImagesFromSession(loaded));
    draftFieldsRef.current = loaded.draftCard;
    draftImagesRef.current = supplierImagesFromSession(loaded);
    draftVersionRef.current += 1;
    savedVersionRef.current = draftVersionRef.current;
    savingVersionRef.current = draftVersionRef.current;
    imagesDirtyRef.current = false;
    setDraftSaveState("idle");
    setDraftSaveError("");
  }, []);

  useEffect(() => {
    if (reloadTick === 0) {
      if (seededSessionIdRef.current === sessionId) {
        return;
      }
      const initial = initialSessionRef.current;
      if (initial && initial.id === sessionId) {
        seededSessionIdRef.current = sessionId;
        hydrateFromSession(initial);
        setLoading(false);
        setLoadError("");
        onConsumeInitialSession?.();
        return;
      }
    }

    seededSessionIdRef.current = null;
    let active = true;
    setLoading(true);
    setLoadError("");
    void productOnboardingApi
      .getSession(sessionId)
      .then((loaded) => {
        if (!active) return;
        hydrateFromSession(loaded);
      })
      .catch((cause) => {
        if (!active) return;
        setSession(null);
        setLoadError(cause instanceof Error ? cause.message : "建档会话加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [sessionId, reloadTick, hydrateFromSession, onConsumeInitialSession]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session?.messages.length, sendingMessage]);

  const flushDraftSave = useCallback(async (): Promise<boolean> => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (sessionStatusRef.current === "completed") return true;

    while (inFlightSaveRef.current) {
      const prevOk = await inFlightSaveRef.current;
      if (!prevOk && draftVersionRef.current === savedVersionRef.current) return false;
    }

    if (draftVersionRef.current <= savedVersionRef.current) {
      return true;
    }

    const activeSessionId = sessionIdRef.current;
    const versionAtSend = draftVersionRef.current;
    const fieldsAtSend = draftFieldsRef.current;
    const imagesAtSend = draftImagesRef.current;
    const includeImages = imagesDirtyRef.current;
    savingVersionRef.current = Math.max(savingVersionRef.current, versionAtSend);

    if (mountedRef.current) {
      setDraftSaveState("saving");
      setDraftSaveError("");
    }

    const runSave = (async () => {
      try {
        const updated = await productOnboardingApi.saveDraft(activeSessionId, {
          draftCard: fieldsAtSend,
          ...(includeImages
            ? { supplierImages: toUpdateSupplierImagePayloads(imagesAtSend) }
            : {}),
        });
        savedVersionRef.current = Math.max(savedVersionRef.current, versionAtSend);
        if (!mountedRef.current || sessionIdRef.current !== activeSessionId) {
          return true;
        }
        setSession((prev) =>
          prev
            ? {
                ...prev,
                title: updated.title,
                status: updated.status,
                missingRequiredFields: updated.missingRequiredFields,
                supplierImages: updated.supplierImages,
                updatedAt: updated.updatedAt,
              }
            : updated,
        );
        if (includeImages && draftVersionRef.current === versionAtSend) {
          imagesDirtyRef.current = false;
          const syncedImages = supplierImagesFromSession(updated);
          draftImagesRef.current = syncedImages;
          setDraftImages(syncedImages);
        }
        if (draftVersionRef.current === versionAtSend) {
          setDraftSaveState("saved");
          setDraftSaveError("");
        }
        return true;
      } catch (cause) {
        if (savingVersionRef.current === versionAtSend) {
          savingVersionRef.current = savedVersionRef.current;
        }
        if (mountedRef.current && sessionIdRef.current === activeSessionId) {
          setDraftSaveState("error");
          setDraftSaveError(cause instanceof Error ? cause.message : "草稿保存失败，请重试");
        }
        return false;
      }
    })();

    inFlightSaveRef.current = runSave;
    const ok = await runSave;
    if (inFlightSaveRef.current === runSave) {
      inFlightSaveRef.current = null;
    }

    if (ok && draftVersionRef.current > savedVersionRef.current && mountedRef.current) {
      return flushDraftSave();
    }
    return ok;
  }, []);

  const scheduleDraftSave = useCallback(
    (delayMs: number) => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      setDraftSaveState("dirty");
      setDraftSaveError("");
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        void flushDraftSave();
      }, delayMs);
    },
    [flushDraftSave],
  );

  const handleDraftFieldsChange = (next: ProductCardFields) => {
    if (session?.status === "completed" || sendingMessage || publishing) return;
    draftFieldsRef.current = next;
    setDraftFields(next);
    draftVersionRef.current += 1;
    scheduleDraftSave(500);
  };

  const handleDraftImagesChange = (next: ProductCardSupplierImageDraft[]) => {
    if (session?.status === "completed" || sendingMessage || publishing) return;
    draftImagesRef.current = next;
    setDraftImages(next);
    imagesDirtyRef.current = true;
    draftVersionRef.current += 1;
    scheduleDraftSave(120);
  };

  const handleShellNavigate = useCallback(
    (to: string, options?: { replace?: boolean }) => {
      if (
        sessionStatusRef.current === "draft" &&
        draftVersionRef.current > savedVersionRef.current
      ) {
        void flushDraftSave().finally(() => {
          navigate(to, options);
        });
        return;
      }
      navigate(to, options);
    },
    [flushDraftSave, navigate],
  );

  const handleNavigateBackHome = () => {
    handleShellNavigate("/");
  };

  const handleSendReply = async () => {
    if (!session || session.status === "completed" || sendingMessage) return;
    const trimmed = replyText.trim();
    if (!trimmed && replyImages.length === 0 && replyTxtFiles.length === 0) return;

    setSendingMessage(true);
    setSendError("");
    try {
      const draftSaved = await flushDraftSave();
      if (!draftSaved) {
        setSendError("请先解决右侧商品卡草稿保存错误后再发送追问消息");
        return;
      }

      const updated = await productOnboardingApi.sendMessage(session.id, {
        ...(trimmed ? { message: trimmed } : {}),
        ...(replyTxtFiles.length > 0
          ? {
              txtFiles: replyTxtFiles.map((txt) => ({
                filename: txt.filename,
                bytesBase64: txt.bytesBase64,
              })),
            }
          : {}),
        ...(replyImages.length > 0
          ? { supplierImages: toCreateSupplierImagePayloads(replyImages) }
          : {}),
      });

      if (!mountedRef.current || sessionIdRef.current !== session.id) return;
      hydrateFromSession(updated);
      setReplyText("");
      setReplyImages([]);
      setReplyTxtFiles([]);
      setSendError("");
    } catch (cause) {
      if (mountedRef.current) {
        setSendError(cause instanceof Error ? cause.message : "发送追问失败，请重试");
      }
    } finally {
      if (mountedRef.current) setSendingMessage(false);
    }
  };

  const handlePublish = async () => {
    if (!session || session.status === "completed" || publishing || sendingMessage) return;
    setPublishing(true);
    setPublishError("");
    try {
      const draftSaved = await flushDraftSave();
      if (!draftSaved) {
        setPublishError("草稿尚未成功保存，请修正右侧表单错误后重试");
        return;
      }
      const published = await productOnboardingApi.publish(session.id);
      if (!mountedRef.current || sessionIdRef.current !== session.id) return;
      hydrateFromSession(published.session);
      setPublishError("");
    } catch (cause) {
      if (mountedRef.current) {
        setPublishError(cause instanceof Error ? cause.message : "保存到商品库失败，请重试");
      }
    } finally {
      if (mountedRef.current) setPublishing(false);
    }
  };

  const isCompleted = session?.status === "completed";
  const localMissingFields = useMemo(
    () => getMissingRequiredProductCardFields(draftFields),
    [draftFields],
  );
  const completedRequiredCount = PRODUCT_CARD_REQUIRED_FIELDS.length - localMissingFields.length;

  const statusText = sendingMessage
    ? "提取中…"
    : publishing
      ? "保存中…"
      : draftSaveState === "saving"
        ? "保存中…"
        : isCompleted
          ? "已入库 · 只读"
          : draftSaveState === "error"
            ? "草稿保存失败"
            : "建档中";

  const statusTone =
    sendingMessage || publishing || draftSaveState === "saving" || loading
      ? "running"
      : loadError || draftSaveState === "error" || sendError || publishError
        ? "error"
        : "pass";

  const renderMessageAttachments = (
    messageId: string,
    attachments: ApiProductOnboardingAttachment[],
  ) => {
    if (attachments.length === 0) return null;
    const txtList = attachments.filter((att) => att.kind === "txt");
    const imgList = attachments.filter((att) => att.kind === "image");

    return (
      <div className="home-msg-attachments">
        <div className="home-msg-att-row">
          {txtList.map((txt, index) => {
            const key = `${messageId}-txt-${index}`;
            const expanded = Boolean(expandedTxtIds[key]);
            return (
              <button
                key={key}
                type="button"
                className={`home-msg-txt-pill ${expanded ? "is-open" : ""}`}
                aria-expanded={expanded}
                onClick={() =>
                  setExpandedTxtIds((prev) => ({ ...prev, [key]: !prev[key] }))
                }
              >
                <Icon name="files" />
                <strong className="home-msg-txt-name">{txt.filename}</strong>
                <span className="home-msg-txt-meta">{txt.charCount} 字</span>
              </button>
            );
          })}
          {imgList.map((img) => (
            <div className="home-msg-image-thumb" key={`${messageId}-${img.imageId}`}>
              <img src={img.thumbnailPreviewUrl} alt={img.filename} loading="lazy" />
              <span title={img.filename}>{img.filename}</span>
            </div>
          ))}
        </div>
        {txtList.map((txt, index) => {
          const key = `${messageId}-txt-${index}`;
          if (!expandedTxtIds[key]) return null;
          return (
            <pre className="home-msg-txt-preview" key={`${key}-preview`}>
              {txt.content}
            </pre>
          );
        })}
      </div>
    );
  };

  const renderAssistantBody = (content: string) => {
    const parsed = parseAssistantContent(content);
    if (!parsed) {
      return <p className="home-msg-text">{content}</p>;
    }
    return (
      <>
        {parsed.intro.map((line, i) => (
          <p className="home-msg-text" key={`intro-${i}`}>
            {line}
          </p>
        ))}
        <ol className="home-msg-followup-list">
          {parsed.numberedItems.map((item, i) => (
            <li key={`item-${i}`}>
              {item.label && <strong>{item.label}</strong>}
              {item.detail}
            </li>
          ))}
        </ol>
        {parsed.outro.map((line, i) => (
          <p className="home-msg-text" key={`outro-${i}`}>
            {line}
          </p>
        ))}
      </>
    );
  };

  return (
    <AppShell
      activeNav="home"
      navigate={handleShellNavigate}
      fullHeight
      crumbs={[
        { label: "首页", to: "/" },
        { label: session?.title ?? "新品建档" },
      ]}
      statusText={statusText}
      statusTone={statusTone}
    >
      <div className="home-session-shell">
        {loading ? (
          <div className="home-session-state" role="status">
            正在加载建档会话…
          </div>
        ) : loadError || !session ? (
          <div className="home-session-state">
            <Icon name="alert" />
            <strong>{loadError || "建档会话不存在"}</strong>
            <div className="home-session-state-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setReloadTick((n) => n + 1)}
              >
                重试加载
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => navigate("/")}
              >
                返回首页
              </button>
            </div>
          </div>
        ) : (
          <>
            {isCompleted && (
              <div
                className="home-completed-banner"
                role="status"
                data-testid="onboarding-completed-banner"
              >
                <div className="home-completed-banner-copy">
                  <span className="home-completed-icon">
                    <Icon name="check" />
                  </span>
                  <div>
                    <strong>
                      商品信息卡「{session.draftCard.name || session.title}」已保存到商品库
                    </strong>
                    <span>当前建档会话已转为只读，可直接带入下游创作工具使用。</span>
                  </div>
                </div>
                <div className="home-completed-banner-actions">
                  {session.productCardId && (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() =>
                          navigate(
                            `/create/suite?productCardId=${encodeURIComponent(session.productCardId!)}`,
                          )
                        }
                      >
                        去生成商品套图
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          navigate(
                            `/create/replica?productCardId=${encodeURIComponent(session.productCardId!)}`,
                          )
                        }
                      >
                        去爆品图复刻
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          navigate(
                            `/products?selected=${encodeURIComponent(session.productCardId!)}`,
                          )
                        }
                      >
                        在商品库查看
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => navigate("/")}
                  >
                    继续录入新品
                  </button>
                </div>
              </div>
            )}

            <div className="home-session-columns">
              {/* Left Conversation Column */}
              <section className="home-chat-pane" aria-label="建档对话栏">
                <header className="home-pane-header">
                  <div className="home-chat-header-left">
                    <button
                      type="button"
                      className="icon-btn home-back-btn"
                      title="返回首页"
                      aria-label="返回首页"
                      onClick={() => void handleNavigateBackHome()}
                    >
                      <Icon name="arrow-left" />
                    </button>
                    <h1 className="home-pane-title" title={session.title}>
                      {session.title}
                    </h1>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm home-new-session-btn"
                    onClick={() => void handleNavigateBackHome()}
                  >
                    <Icon name="plus" />
                    <span>新建</span>
                  </button>
                </header>

                <div className="home-chat-messages" aria-label="建档消息记录">
                  {session.messages.map((msg) =>
                    msg.role === "user" ? (
                      <article
                        key={msg.id}
                        className="home-msg is-user"
                        data-message-role="user"
                      >
                        {msg.content && <div className="home-msg-text">{msg.content}</div>}
                        {renderMessageAttachments(msg.id, msg.attachments)}
                      </article>
                    ) : (
                      <article
                        key={msg.id}
                        className="home-msg is-assistant"
                        data-message-role="assistant"
                      >
                        <span className="home-assistant-avatar" aria-hidden="true">
                          <img src="/logo.png" alt="" />
                        </span>
                        <div className="home-msg-assistant-body">
                          {msg.content && renderAssistantBody(msg.content)}
                          {renderMessageAttachments(msg.id, msg.attachments)}
                          <span className="home-msg-time">
                            {formatShortDateTime(msg.createdAt)}
                          </span>
                        </div>
                      </article>
                    ),
                  )}

                  {sendingMessage && (
                    <article className="home-msg is-assistant is-loading" role="status">
                      <span className="home-assistant-avatar" aria-hidden="true">
                        <img src="/logo.png" alt="" />
                      </span>
                      <div className="home-msg-assistant-body">
                        <span className="home-msg-loading-pill">
                          <span className="home-loading-dot" aria-hidden="true" />
                          <span>提取中…</span>
                        </span>
                      </div>
                    </article>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {sendError && (
                  <div className="home-chat-error" role="alert">
                    <Icon name="alert" />
                    <div className="home-inline-alert-text">
                      <ModelSettingsMessage message={sendError} />
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm home-inline-retry"
                      disabled={sendingMessage}
                      onClick={() => void handleSendReply()}
                    >
                      重试发送
                    </button>
                  </div>
                )}

                {isCompleted ? (
                  <div className="home-chat-readonly-bar" data-testid="chat-readonly-notice">
                    <Icon name="lock" />
                    <span>已建卡 · 如需修改商品信息请前往商品库</span>
                    {session.productCardId && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          navigate(
                            `/products?selected=${encodeURIComponent(session.productCardId!)}`,
                          )
                        }
                      >
                        前往商品库
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="home-chat-composer-wrap">
                    <OnboardingComposer
                      variant="reply"
                      message={replyText}
                      onMessageChange={setReplyText}
                      pendingImages={replyImages}
                      onPendingImagesChange={setReplyImages}
                      pendingTxtFiles={replyTxtFiles}
                      onPendingTxtFilesChange={setReplyTxtFiles}
                      existingSessionImages={draftImages}
                      sending={sendingMessage || publishing}
                      onSubmit={handleSendReply}
                      ariaLabel="补充商品信息输入框"
                      placeholder="补充适用场景、包装清单或更正字段，也可以点击 ＋ 追加附件…"
                      submitLabel="发送"
                      sendingLabel="提取中…"
                    />
                  </div>
                )}
              </section>

              {/* Right Flat Product Card Form Column */}
              <section className="home-card-pane" aria-label="商品信息卡面板">
                <header className="home-pane-header">
                  <div className="home-card-header-left">
                    <h2 className="home-pane-title">商品信息卡</h2>
                    {!isCompleted && draftSaveState === "saving" && (
                      <span className="home-draft-save-status">保存中…</span>
                    )}
                    {!isCompleted && draftSaveState === "saved" && (
                      <span className="home-draft-save-status">已自动保存</span>
                    )}
                    {!isCompleted && draftSaveState === "dirty" && (
                      <span className="home-draft-save-status">待保存…</span>
                    )}
                    {!isCompleted && draftSaveState === "error" && (
                      <button
                        type="button"
                        className="home-draft-retry-btn"
                        onClick={() => void flushDraftSave()}
                      >
                        保存失败 · 重试
                      </button>
                    )}
                  </div>
                  <span
                    className={`home-progress-pill ${localMissingFields.length === 0 ? "is-done" : ""}`}
                    data-testid="required-progress-pill"
                  >
                    <i aria-hidden="true" />
                    <span>
                      {localMissingFields.length === 0
                        ? "6/6 必填已齐"
                        : `已填 ${completedRequiredCount}/6 必填`}
                    </span>
                  </span>
                </header>

                <div className="home-card-pane-body">
                  {draftSaveError && (
                    <div className="home-card-pane-alerts">
                      <div className="home-inline-alert" role="alert">
                        <Icon name="alert" />
                        <div className="home-inline-alert-text">{draftSaveError}</div>
                        <button
                          type="button"
                          className="btn btn-sm home-inline-retry"
                          onClick={() => void flushDraftSave()}
                        >
                          重试保存
                        </button>
                      </div>
                    </div>
                  )}

                  {publishError && (
                    <div className="home-card-pane-alerts">
                      <div className="home-inline-alert" role="alert">
                        <Icon name="alert" />
                        <div className="home-inline-alert-text">{publishError}</div>
                      </div>
                    </div>
                  )}

                  <ProductCardEditorForm
                    fields={draftFields}
                    supplierImages={draftImages}
                    onFieldsChange={handleDraftFieldsChange}
                    onSupplierImagesChange={handleDraftImagesChange}
                    onSubmit={handlePublish}
                    submitLabel="保存到商品库"
                    submitting={publishing}
                    disabled={sendingMessage}
                    readOnly={isCompleted}
                    highlightMissing={!isCompleted}
                    externalMissingFields={isCompleted ? undefined : session.missingRequiredFields}
                    idPrefix={`onboarding-${session.id}`}
                    layout="panel"
                  />
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
