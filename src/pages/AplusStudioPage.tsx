import { usePolling } from "../hooks/usePolling";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  APLUS_SIZE_PRESETS, isAplusPlanStale, normalizeAplusLanguage, validateAplusSizePresets,
} from "../../shared/aplus";
import { ApiHttpError, createIdempotencyKey, productCardsApi, suiteApi, type ApiImage, type ApiPlatformProfile } from "../api/client";
import { AppShell } from "../components/AppShell";
import { GenerationHistoryDrawer } from "../components/generation-history/GenerationHistoryDrawer";
import { formatHistoryTime } from "../components/generation-history/history-model";
import { toSelectedProductCardSummary } from "../components/product-card-picker/types";
import { message } from "../components/suite-studio/studio";
import { StudioProgressBar } from "../components/suite-studio/StudioProgressBar";
import { AplusConfigPanel } from "../features/aplus/AplusConfigPanel";
import { AplusEmptyState } from "../features/aplus/AplusEmptyState";
import { AplusPlanReview } from "../features/aplus/AplusPlanReview";
import { AplusResultCards } from "../features/aplus/AplusResultCards";
import { clearAplusWorkspace, readAplusBatch, readAplusWorkspace, saveAplusBatch, saveAplusWorkspace } from "../features/aplus/aplus-draft-store";
import {
  aplusApi, aplusPath, configForPlatform, currentPlanInput, makeAplusAiWritePayload, makeAplusPayload, newAplusDraft,
  type AplusConfig, type AplusDraft, type AplusStudioState,
} from "../features/aplus/aplus-studio";
import { CreateToolsNav } from "../features/create/CreateToolsNav";
import "../components/suite-studio/studio.css";
import "../features/aplus/aplus-studio.css";

interface Props {
  suiteId?: string;
  initialProductCardId?: string;
  navigate: (path: string) => void;
}

const batchStatusLabels: Record<string, string> = {
  waiting_human_input: "等待确认",
  completed: "已完成",
  partial_failed: "部分失败",
  failed: "生成失败",
};

export function AplusStudioPage({ suiteId, initialProductCardId, navigate }: Props) {
  const [newCount, setNewCount] = useState(0);
  const saved = readAplusWorkspace();
  const activeId = suiteId ?? (initialProductCardId ? undefined : saved?.suiteId ?? undefined);
  const routeKey = activeId ? `suite:${activeId}` : initialProductCardId ? `card:${initialProductCardId}` : saved?.routeKey ?? "new";
  return (
    <AplusWorkspace
      key={`${routeKey}:${newCount}`}
      suiteId={activeId}
      initialProductCardId={activeId ? undefined : initialProductCardId}
      routeKey={routeKey}
      navigate={navigate}
      onNew={() => {
        clearAplusWorkspace();
        setNewCount((count) => count + 1);
        navigate("/create/aplus");
      }}
    />
  );
}

function draftFromBatch(state: AplusStudioState): AplusDraft {
  const draft = newAplusDraft();
  const { inputSnapshot: input, productCardSnapshot: card } = state;
  return {
    ...draft,
    images: state.inputImages,
    config: input ? {
      platform: input.platform,
      targetMarket: input.targetMarket,
      language: normalizeAplusLanguage(input.language),
      visualStyle: input.visualStyle ?? "auto",
      sizePresets: input.sizePresets,
      modules: input.modules,
      productInfo: input.productInfo,
      productCard: card ? toSelectedProductCardSummary(card) : null,
      resolution: state.resolution ?? draft.config.resolution,
    } : draft.config,
  };
}

function AplusWorkspace({
  suiteId, initialProductCardId, routeKey, navigate, onNew,
}: Props & { routeKey: string; onNew: () => void }) {
  const [savedDraft] = useState(() => {
    const saved = readAplusWorkspace();
    return saved?.routeKey === routeKey ? saved.draft : null;
  });
  const [state, setState] = useState(() => readAplusBatch(suiteId));
  const [draft, setDraft] = useState(() => savedDraft ?? (state ? draftFromBatch(state) : newAplusDraft()));
  const draftRef = useRef(draft);
  const [profiles, setProfiles] = useState<ApiPlatformProfile[]>([]);
  const [loading, setLoading] = useState(Boolean(suiteId && !state));
  const [batchError, setBatchError] = useState("");
  const [loadingCard, setLoadingCard] = useState(Boolean(initialProductCardId));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState("");
  const actionRef = useRef("");
  const [forcedStale, setForcedStale] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const mounted = useRef(false);
  const resultsRef = useRef<HTMLElement>(null);
  const refreshSequence = useRef(0);
  const appliedRefresh = useRef(0);
  const requestKey = useRef<{ signature: string; key: string } | null>(null);

  const commitDraft = useCallback((next: AplusDraft) => {
    const active = mounted.current;
    if (active || readAplusWorkspace()?.draft === draftRef.current) {
      saveAplusWorkspace({ routeKey, suiteId: suiteId ?? null, draft: next });
    }
    draftRef.current = next;
    if (active) setDraft(next);
  }, [routeKey, suiteId]);

  const updateConfig = useCallback((config: AplusConfig) => {
    const current = draftRef.current;
    let aiWrite = current.aiWrite;
    if (!config.productCard || config.productCard.cardId !== current.config.productCard?.cardId) {
      aiWrite = undefined;
    } else if (aiWrite?.truncated && config.productInfo !== current.config.productInfo) {
      aiWrite = { ...aiWrite, truncated: false };
    }
    commitDraft({ ...current, config, aiWrite });
  }, [commitDraft]);

  useEffect(() => {
    mounted.current = true;
    const previous = document.title;
    document.title = "A+详情 · PicAgent";
    if (savedDraft || readAplusBatch(suiteId) || (!suiteId && !initialProductCardId)) {
      commitDraft(draftRef.current);
    }
    return () => {
      mounted.current = false;
      document.title = previous;
    };
  }, [commitDraft, initialProductCardId, savedDraft, suiteId]);

  useEffect(() => {
    let active = true;
    suiteApi.listPlatforms().then((loaded) => {
      if (active) setProfiles(loaded);
    }).catch((error) => {
      if (active) setNotice(message(error));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setLoadingCard(Boolean(initialProductCardId));
    if (!initialProductCardId) return;
    let active = true;

    function clearPreselectedCard() {
      const current = draftRef.current;
      if (current.config.productCard?.cardId === initialProductCardId) {
        updateConfig({ ...current.config, productCard: null });
      }
    }

    void productCardsApi.get(initialProductCardId).then((card) => {
      if (!active) return;
      if (card.status === "published") {
        const current = draftRef.current;
        updateConfig({ ...current.config, productCard: toSelectedProductCardSummary(card) });
      } else {
        clearPreselectedCard();
        setNotice("指定商品信息卡已归档，请重新选择。");
      }
    }).catch((error) => {
      if (!active) return;
      clearPreselectedCard();
      setNotice(message(error));
    }).finally(() => {
      if (active) setLoadingCard(false);
    });
    return () => { active = false; };
  }, [updateConfig, initialProductCardId]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!suiteId) return;
    const sequence = ++refreshSequence.current;
    const next = await aplusApi.state(suiteId, signal);
    if (signal?.aborted || !mounted.current || sequence < appliedRefresh.current) return;
    appliedRefresh.current = sequence;
    if (readAplusWorkspace()?.routeKey !== routeKey) commitDraft(draftFromBatch(next));
    saveAplusBatch(next);
    setState(next);
    setBatchError("");
  }, [commitDraft, routeKey, suiteId]);

  const load = useCallback(async () => {
    try {
      await refresh();
    } catch (error) {
      if (mounted.current) setBatchError(message(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [refresh]);

  useEffect(() => { if (suiteId) void load(); }, [suiteId, load]);

  const running = state?.pipeline?.status === "running";
  usePolling(refresh, {
    enabled: running,
    intervalMs: 2000,
    onError: error => setBatchError(message(error)),
  }, [refresh]);

  const { images } = draft;
  const fallbackProfile = profiles.find(({ code }) => code === "amazon") ?? profiles[0];
  const config = !draft.config.platform && fallbackProfile ? configForPlatform(draft.config, fallbackProfile) : draft.config;
  const profile = profiles.find(({ code }) => code === config.platform);
  const validSize = Boolean(profile && validateAplusSizePresets(config.sizePresets, profile.detailSizePresets));
  const awaiting = state?.pipeline?.currentPhase === "awaiting_confirmation";
  const failed = state?.pipeline?.status === "failed" || state?.pipeline?.status === "partial_failed";
  const planningFailed = failed && state?.pipeline?.currentPhase === "aplus_planning";
  const stale = Boolean((awaiting || planningFailed) && state?.inputSnapshot && (
    forcedStale || isAplusPlanStale(state.inputSnapshot, currentPlanInput(config, images))
  ));
  const cardIdToCheck = awaiting ? config.productCard?.cardId : undefined;
  useEffect(() => {
    if (!cardIdToCheck) return;
    let active = true;
    void productCardsApi.get(cardIdToCheck).then((card) => {
      const current = draftRef.current;
      if (!active || current.config.productCard?.cardId !== cardIdToCheck) return;
      if (card.status !== "published" || card.revision !== current.config.productCard.revision) {
        const productCard = card.status === "published" ? toSelectedProductCardSummary(card) : null;
        updateConfig({ ...current.config, productCard });
      }
    }).catch(() => {
      // Confirmation also checks the current revision on the server.
    });
    return () => { active = false; };
  }, [cardIdToCheck, updateConfig]);
  const confirmBlocked = loading || loadingCard || !validSize;
  const configBlocked = loading ? "正在读取批次…" : loadingCard ? "正在读取商品信息卡…"
    : action === "upload" ? "正在上传商品原图…" : running ? "当前批次正在处理。"
    : !profile ? "请选择可用的平台。" : !validSize ? "请选择可用的详情尺寸。" : "";
  const canPlan = !configBlocked && images.length > 0 && config.modules.length > 0
    && Boolean(config.productCard || config.productInfo.trim());
  const busy = Boolean(action || running || loading || loadingCard);
  const planModules = draft.planEdits ?? state?.modules ?? [];

  async function act(label: string, work: () => Promise<void>) {
    if (actionRef.current) return;
    actionRef.current = label;
    setAction(label);
    setNotice("");
    try {
      await work();
    } catch (error) {
      if (mounted.current) setNotice(message(error));
    } finally {
      actionRef.current = "";
      if (mounted.current) setAction("");
    }
  }

  function idempotencyKey(action: string, payload?: object) {
    const signature = JSON.stringify([action, suiteId, payload]);
    if (requestKey.current?.signature !== signature) {
      requestKey.current = { signature, key: createIdempotencyKey() };
    }
    return requestKey.current.key;
  }

  function openBatch(id: string) {
    saveAplusWorkspace({
      routeKey: `suite:${id}`,
      suiteId: id,
      draft: { ...draftRef.current, config, planEdits: null, job: null },
    });
    if (mounted.current) navigate(aplusPath(id));
  }

  function startPlan() {
    if (!canPlan) return;
    const payload = makeAplusPayload(config, images);
    void act("plan", async () => {
      const previous = awaiting || planningFailed ? suiteId : undefined;
      const started = await aplusApi.start(previous, payload, idempotencyKey("plan", payload));
      requestKey.current = null;
      if (mounted.current || readAplusWorkspace()?.draft === draftRef.current) openBatch(started.suiteId);
    });
  }

  function aiWrite() {
    if (busy || !images.length || !profile || !config.productCard) return;
    void act("ai-write", async () => {
      const { productInfo, truncated } = await aplusApi.aiWrite(makeAplusAiWritePayload(config, images));
      const current = draftRef.current;
      if (current.config.productCard?.cardId !== config.productCard?.cardId) return;
      commitDraft({
        ...current,
        config: { ...current.config, productInfo },
        aiWrite: { previousInfo: config.productInfo, truncated },
      });
    });
  }

  function undoAiWrite() {
    const current = draftRef.current;
    if (busy || !current.aiWrite) return;
    commitDraft({
      ...current,
      config: { ...current.config, productInfo: current.aiWrite.previousInfo },
      aiWrite: undefined,
    });
  }

  async function savePlan() {
    if (!suiteId || !state || !draftRef.current.planEdits) return;
    const saved = await aplusApi.savePlan(suiteId, draftRef.current.planEdits);
    if (!mounted.current) return;
    const next = { ...state, ...saved };
    saveAplusBatch(next);
    setState(next);
    commitDraft({ ...draftRef.current, planEdits: null });
  }

  function confirm() {
    if (!suiteId || stale || confirmBlocked) return;
    const payload = makeAplusPayload(config, images);
    void act("confirm", async () => {
      try {
        await savePlan();
        await aplusApi.confirm(suiteId, payload, idempotencyKey("confirm", payload));
        await refresh();
        requestKey.current = null;
      } catch (error) {
        if (mounted.current && error instanceof ApiHttpError && error.code === "APLUS_PLAN_STALE") {
          setForcedStale(true);
          const selected = draftRef.current.config.productCard;
          if (selected) {
            const card = await productCardsApi.get(selected.cardId).catch(() => null);
            if (mounted.current) updateConfig({
              ...draftRef.current.config, productCard: card?.status === "published" ? toSelectedProductCardSummary(card) : null,
            });
          }
        }
        throw error;
      }
    });
  }

  function resume() {
    if (!suiteId) return;
    void act("resume", async () => {
      await aplusApi.resume(suiteId, idempotencyKey("resume"));
      await refresh();
      requestKey.current = null;
    });
  }

  function upload(files: File[]) {
    if (busy || !files.length) return;
    void act("upload", async () => {
      let uploadSuiteId = draft.uploadSuiteId;
      if (!uploadSuiteId) {
        const created = await suiteApi.create(config.productCard?.name || "A+详情原图");
        uploadSuiteId = created.id;
        const copied: ApiImage[] = [];
        try {
          for (const image of images) {
            const original = await fetch(image.originalPreviewUrl);
            if (!original.ok) throw new Error(`无法读取商品原图「${image.originalFilename}」。`);
            const file = new File([await original.blob()], image.originalFilename, { type: image.mimeType });
            copied.push(await suiteApi.upload(uploadSuiteId, file, copied.length + 1));
          }
        } catch (error) {
          await suiteApi.delete(uploadSuiteId).catch(() => undefined);
          throw error;
        }
        commitDraft({ ...draftRef.current, images: copied, uploadSuiteId });
      }
      for (const file of files) {
        const current = draftRef.current;
        const ordinal = [1, 2, 3, 4, 5, 6].find((value) => !current.images.some((image) => image.ordinal === value))!;
        const image = await suiteApi.upload(uploadSuiteId, file, ordinal);
        commitDraft({ ...current, images: [...current.images, image] });
      }
    });
  }

  function remove(image: ApiImage) {
    void act("remove", async () => {
      if (draft.uploadSuiteId === image.suiteId) await suiteApi.removeInputImage(image.suiteId, image.id);
      commitDraft({ ...draftRef.current, images: draftRef.current.images.filter((item) => item.id !== image.id) });
    });
  }

  function rename() {
    if (!suiteId || !name.trim()) return;
    void act("rename", async () => {
      const renamed = await suiteApi.rename(suiteId, name.trim());
      if (mounted.current && state) {
        const next = { ...state, suite: renamed };
        saveAplusBatch(next);
        setState(next);
        setEditingName(false);
      }
    });
  }

  function deleteBatch() {
    if (!suiteId || !state || busy || !window.confirm(`确定删除批次「${state.suite.name}」吗？删除后将从生成记录中移除。`)) return;
    void act("delete", async () => {
      await suiteApi.delete(suiteId);
      if (mounted.current) onNew();
      else if (readAplusWorkspace()?.suiteId === suiteId) clearAplusWorkspace();
    });
  }

  const batchSizes = state?.inputSnapshot?.sizePresets ?? [];
  const batchPlatform = state?.inputSnapshot?.platform;
  const platformName = profiles.find(({ code }) => code === batchPlatform)?.name ?? batchPlatform;
  const batchMeta = [platformName, batchSizes.map((key) => APLUS_SIZE_PRESETS[key].name).join(" / "), formatHistoryTime(state?.suite.createdAt)]
    .filter(Boolean).join(" · ");
  const planning = state?.pipeline?.currentPhase === "aplus_planning";
  const moduleCount = planning ? state.inputSnapshot?.modules.length ?? 0 : planModules.length;
  const total = state?.progress.total || moduleCount * batchSizes.length;
  const completed = state?.progress.completed ?? 0;
  const badgeText = running
    ? (planning ? "策划中…" : total > 0 ? `生成中 ${completed}/${total}` : "生成中…")
    : batchStatusLabels[state?.pipeline?.status ?? ""];
  const processing = action === "plan" || action === "confirm" || action === "resume" || running;
  const status = loading ? "正在读取 A+ 批次" : processing ? "A+详情处理中"
    : awaiting ? "等待方案确认" : "工作台就绪";

  return (
    <AppShell
      activeNav="create"
      crumbs={[{ label: "创建", to: "/create/suite" }, { label: "A+详情" }]}
      navigate={navigate}
      fullHeight
      className="ss-shell"
      statusText={status}
      statusTone={processing ? "running" : "pass"}
    >
      <div className="ss-layout aplus-layout">
        <CreateToolsNav activeTool="aplus" navigate={navigate} />
        <AplusConfigPanel
          config={config}
          profiles={profiles}
          images={images}
          busy={busy}
          blocked={configBlocked}
          submitting={action === "plan"}
          aiWriting={action === "ai-write"}
          aiWrite={draft.aiWrite}
          stale={stale}
          awaitingConfirmation={awaiting}
          onChange={updateConfig}
          onUpload={upload}
          onUploadError={setNotice}
          onRemove={remove}
          onAiWrite={aiWrite}
          onUndoAiWrite={undoAiWrite}
          onSubmit={startPlan}
          onViewPlan={() => resultsRef.current?.scrollIntoView({ block: "start" })}
        />
        <main className="ss-results aplus-results" ref={resultsRef}>
          <header className="ss-results-head">
            <div>
              {editingName ? (
                <form className="aplus-title-form" onSubmit={(event) => { event.preventDefault(); rename(); }}>
                  <input aria-label="任务名" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} autoFocus />
                  <button type="submit" disabled={busy || !name.trim()}>保存</button>
                  <button type="button" onClick={() => setEditingName(false)}>取消</button>
                </form>
              ) : (
                <div className="aplus-batch-title">
                  <h2>{state?.suite.name ?? "A+详情结果"}</h2>
                  {badgeText && (
                    <span className="ss-status" data-status={state?.pipeline?.status}>
                      {running && <span className="ss-status-dot" aria-hidden="true" />}
                      {badgeText}
                    </span>
                  )}
                  {state && <button type="button" disabled={busy} onClick={() => { setName(state.suite.name); setEditingName(true); }}>改名</button>}
                </div>
              )}
              {batchMeta && <small>{batchMeta}</small>}
            </div>
            <div className="ss-results-actions">
              <button type="button" disabled={Boolean(action)} onClick={() => setHistoryOpen(true)}>生成记录</button>
              {state && <button type="button" disabled={busy} onClick={deleteBatch}>删除批次</button>}
              <button type="button" disabled={Boolean(action)} onClick={onNew}>＋ 新建</button>
            </div>
          </header>
          {notice && (
            <div className="ss-note" role="status">
              <span>{notice}</span>
              <button type="button" aria-label="关闭提示" onClick={() => setNotice("")}>×</button>
            </div>
          )}
          {batchError && (
            <div className="ss-batch-error" role="alert">
              <p>{batchError}</p>
              <button type="button" onClick={() => void load()}>重新读取</button>
            </div>
          )}
          {loading && <p role="status">正在读取 A+ 批次…</p>}
          {!suiteId && !loading && <AplusEmptyState />}
          {running && (
            <StudioProgressBar
              headline={planning ? "正在分析商品原图与卖点，规划 A+ 详情策划方案…"
                : total > 0 ? `正在生成 A+ 详情图片（已完成 ${completed}/${total} 张）…` : "正在生成 A+ 详情图片…"}
              percent={planning ? 25 : Math.round(38 + (total > 0 ? Math.min(1, completed / total) : 0) * 60)}
              progressLabel="A+详情生成进度"
              stepsLabel="A+详情阶段进度"
              steps={[
                { key: "aplus_planning", index: "1", label: "策划方案", state: planning ? "active" : "done" },
                { key: "awaiting_confirmation", index: "2", label: "确认方案", state: planning ? "pending" : "done" },
                { key: "image_generating", index: "3", label: `生成图片 (${completed}/${total})`, state: planning ? "pending" : "active" },
              ]}
            />
          )}
          {failed && (
            <div className="ss-batch-error" role="alert">
              <p>{state.pipeline?.errorMessage ?? (planningFailed ? "方案规划失败。" : "部分图片未生成。")}</p>
              {planningFailed && stale ? (
                <small>配置已变更，请重新规划。</small>
              ) : (
                <button type="button" disabled={busy} onClick={resume}>{planningFailed ? "重试规划" : "继续出图"}</button>
              )}
            </div>
          )}
          {awaiting && (
            <AplusPlanReview
              globalPlan={state.globalPlan}
              modules={planModules}
              language={state.inputSnapshot?.language ?? config.language}
              stale={stale}
              busy={busy || confirmBlocked}
              blocked={!canPlan}
              edited={Boolean(draft.planEdits)}
              onChange={(planEdits) => commitDraft({ ...draftRef.current, planEdits })}
              onSave={() => void act("save", savePlan)}
              onConfirm={confirm}
              onReplan={startPlan}
            />
          )}
          {state?.pipeline?.status === "completed" && <p className="aplus-completed" role="status">已完成 · {state.progress.completed} 张</p>}
          {state && state.cards.length > 0 && (
            <AplusResultCards
              suiteId={state.suite.id}
              suiteName={state.suite.name}
              cards={state.cards}
              sizes={batchSizes}
              disabled={busy}
              job={draft.job}
              onJob={(job) => commitDraft({ ...draftRef.current, job })}
              refresh={refresh}
              onNotice={setNotice}
            />
          )}
        </main>
        <GenerationHistoryDrawer
          origin="aplus"
          open={historyOpen}
          currentSuiteId={suiteId}
          onClose={() => setHistoryOpen(false)}
          onSelect={(id) => {
            setHistoryOpen(false);
            if (id === suiteId) void load();
            else navigate(aplusPath(id));
          }}
        />
      </div>
    </AppShell>
  );
}
