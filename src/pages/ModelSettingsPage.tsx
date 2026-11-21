import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { capabilityLabels, defaultImageOptions, type ImageOptions, type ModelCapability, type ModelChannel, type ModelChannelInput, type ModelPreferences, type ModelReference, type ModelSettingsView } from "../../shared/model-settings";
import { modelSettingsApi } from "../api/client";
import { Icon } from "./shared";
import { AppShell } from "../components/AppShell";
import "./ModelSettingsPage.css";

const capabilities = ["image", "vision"] as const;
const emptyChannel = (): ModelChannelInput => ({ name: "", protocol: "openai-compatible", baseUrl: "", apiKey: "", models: [] });
const choiceValue = (ref: ModelReference | null) => ref ? JSON.stringify([ref.channelId, ref.modelId]) : "";

function ImageOptionsFields({ options, onChange }: { options: ImageOptions; onChange: (options: ImageOptions) => void }) {
  const [ratios, setRatios] = useState(options.aspectRatios.join(", "));
  return <div className="settings-fields" role="group" aria-label="生图尺寸能力">
    <div>支持的分辨率档位<div className="settings-capabilities">{["1K", "2K", "4K"].map((size) => <label key={size}>
      <input type="checkbox" checked={options.sizes.includes(size)} onChange={(event) => onChange({ ...options, sizes: event.target.checked ? [...options.sizes, size] : options.sizes.filter((item) => item !== size) })} />{size}
    </label>)}</div></div>
    <label>支持的比例<input required value={ratios} placeholder="1:1, 2:3, 3:2" onChange={(event) => {
      setRatios(event.target.value);
      onChange({ ...options, aspectRatios: event.target.value.split(/[,，\s]+/).filter(Boolean) });
    }} /></label>
    <label>尺寸模式<select value={options.sizeMode} onChange={(event) => onChange({ ...options, sizeMode: event.target.value as ImageOptions["sizeMode"] })}>
      <option value="tier">档位（tier）</option><option value="pixels">像素（pixels）</option>
    </select></label>
    <small>{options.sizeMode === "tier" ? "比例由模型尽量遵循。" : "按比例和档位换算像素；请仅配置当前渠道支持的比例。"}账号分组上限需自行确认，4K 出图更慢、费用更高。</small>
  </div>;
}

function ChannelModelPicker({ models, onPull, onClose, onConfirm }: {
  models: ModelChannelInput["models"];
  onPull: (signal: AbortSignal) => Promise<{ modelIds: string[] }>;
  onClose: () => void;
  onConfirm: (ids: string[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [search, setSearch] = useState("");
  const [manualId, setManualId] = useState("");
  const [tab, setTab] = useState<"new" | "existing">("new");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selected, setSelected] = useState(new Set<string>());
  const [pulling, setPulling] = useState(false);
  const [pulled, setPulled] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialog.current?.showModal();
    return () => pending.current?.abort();
  }, []);

  const existingIds = models.map(({ id }) => id);
  const existing = new Set(existingIds);
  const visibleIds = (tab === "new" ? candidates : existingIds).filter((id) => id.toLowerCase().includes(search.trim().toLowerCase()));
  const updateSelection = (ids: string[], checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    return next;
  });

  const addManual = () => {
    const id = manualId.trim();
    if (!id) return;
    setManualId("");
    setSearch("");
    if (existing.has(id)) {
      setTab("existing");
      return;
    }
    setTab("new");
    setCandidates((current) => current.includes(id) ? current : [...current, id]);
    updateSelection([id], true);
  };

  const pull = async () => {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setPulling(true);
    setError("");
    try {
      const { modelIds } = await onPull(request.signal);
      setCandidates((current) => [...new Set([...current, ...modelIds.filter((id) => !existing.has(id))])]);
      setTab("new");
      setPulled(true);
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "拉取模型列表失败，请手动添加模型");
    } finally {
      pending.current = null;
      if (!request.signal.aborted) setPulling(false);
    }
  };

  const checkedCount = visibleIds.filter((id) => selected.has(id)).length;
  const close = () => {
    dialog.current?.close();
    onClose();
  };

  return <dialog ref={dialog} className="settings-model-picker" aria-labelledby="model-picker-title" onCancel={(event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  }}>
    <header className="settings-drawer-header">
      <div className="settings-picker-title"><h2 id="model-picker-title">选择渠道模型</h2><small aria-live="polite">已选 {selected.size} / {candidates.length}</small></div>
      <button type="button" className="settings-icon-button" onClick={close} aria-label="关闭"><Icon name="x" /></button>
    </header>
    <div className="settings-picker-tools">
      <input type="search" aria-label="搜索模型" placeholder="搜索模型" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="settings-picker-manual">
        <input aria-label="模型 ID" placeholder="输入模型 ID" value={manualId} onChange={(event) => setManualId(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addManual(); }
        }} />
        <button type="button" className="settings-button" disabled={!manualId.trim()} onClick={addManual}>添加</button>
      </div>
      <button type="button" className="settings-button" disabled={pulling} onClick={() => void pull()}>{pulling ? "拉取中…" : "拉取模型列表"}</button>
    </div>
    {error && <p className="settings-error settings-picker-error" role="alert">{error}</p>}
    <div className="settings-picker-tabs" role="group" aria-label="模型列表">
      <button type="button" aria-pressed={tab === "new"} onClick={() => setTab("new")}>待添加的模型 ({candidates.length})</button>
      <button type="button" aria-pressed={tab === "existing"} onClick={() => setTab("existing")}>已有的模型 ({existingIds.length})</button>
    </div>
    <div className="settings-picker-body">
      {tab === "new" && visibleIds.length > 0 && <div className="settings-picker-selection">
        <small>当前列表已选 {checkedCount} / {visibleIds.length}</small>
        <button type="button" className="settings-button" disabled={checkedCount === visibleIds.length} onClick={() => updateSelection(visibleIds, true)}>全选当前列表</button>
        <button type="button" className="settings-button" disabled={!checkedCount} onClick={() => updateSelection(visibleIds, false)}>取消当前列表</button>
      </div>}
      {visibleIds.length > 0 ? <ul className="settings-picker-list">{visibleIds.map((id) => <li key={id}>
        {tab === "new" ? <label><input type="checkbox" checked={selected.has(id)} onChange={(event) => updateSelection([id], event.target.checked)} /><span>{id}</span></label> : <span>{id}</span>}
      </li>)}</ul> : <p className="settings-picker-empty" role="status">{search.trim() ? "没有匹配的模型。" : tab === "existing" ? "渠道暂无模型。" : pulling ? "正在拉取模型列表…" : pulled ? "没有新的模型可添加。" : "输入模型 ID 或拉取模型列表。"}</p>}
    </div>
    <footer className="settings-drawer-footer">
      <button type="button" className="settings-button" onClick={close}>取消</button>
      <button type="button" className="settings-button settings-primary" disabled={!selected.size} onClick={() => {
        dialog.current?.close();
        onConfirm(candidates.filter((id) => selected.has(id)));
      }}>确定</button>
    </footer>
  </dialog>;
}

function ChannelDrawer({ channel, onClose, onSave }: {
  channel: ModelChannel | null;
  onClose: () => void;
  onSave: (input: ModelChannelInput) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<ModelChannelInput>(() => channel
    ? { name: channel.name, protocol: channel.protocol, baseUrl: channel.baseUrl, models: channel.models, apiKey: "" }
    : emptyChannel());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => { dialog.current?.showModal(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try { await onSave(draft); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存渠道失败"); }
    finally { setSaving(false); }
  };

  const setCapability = (id: string, capability: ModelCapability, checked: boolean) => {
    setDraft((value) => ({ ...value, models: value.models.map((model) => model.id === id ? {
      ...model, capabilities: checked ? [...model.capabilities, capability] : model.capabilities.filter((item) => item !== capability),
      ...(capability === "image" && checked ? { imageOptions: model.imageOptions ?? defaultImageOptions(model.id) } : {}),
    } : model) }));
  };

  return <dialog ref={dialog} className="settings-drawer" aria-labelledby="channel-drawer-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={submit}>
      <header className="settings-drawer-header">
        <h2 id="channel-drawer-title">{channel ? "编辑渠道" : "新增渠道"}</h2>
        <button type="button" className="settings-icon-button" onClick={onClose} disabled={saving} aria-label="关闭"><Icon name="x" /></button>
      </header>
      <div className="settings-drawer-body">
        <fieldset disabled={saving} className="settings-fields">
          <label>渠道名称<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：团队生图网关" /></label>
          <label>协议<select defaultValue={draft.protocol}><option value="openai-compatible">OpenAI 兼容</option></select></label>
          <label>接口地址<input type="url" required value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
          <label>API Key
            <input type="password" autoComplete="new-password" spellCheck={false} required={!channel?.hasApiKey} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
            {channel?.hasApiKey && <small>已配置。接口地址不变时留空可保留原密钥。</small>}
          </label>
          <section aria-labelledby="channel-models-title">
            <header className="settings-section-head"><h3 id="channel-models-title">渠道模型</h3><button type="button" className="settings-button" aria-haspopup="dialog" onClick={() => setPickerOpen(true)}>添加模型</button></header>
            {draft.models.length > 0 && <p className="settings-model-hint">每个模型至少选择一种能力。</p>}
            {draft.models.map((model) => <div role="group" aria-label={model.id} className="settings-model" key={model.id}>
              <div className="settings-model-heading">
                <strong>{model.id}</strong>
                <button type="button" className="settings-button settings-danger" aria-label={`移除模型 ${model.id}`} onClick={() => setDraft((value) => ({ ...value, models: value.models.filter(({ id }) => id !== model.id) }))}>移除</button>
              </div>
              <div className="settings-capabilities">{capabilities.map((capability) => <label key={capability}>
                <input type="checkbox" checked={model.capabilities.includes(capability)} onChange={(event) => setCapability(model.id, capability, event.target.checked)} />
                {capabilityLabels[capability]}
              </label>)}</div>
              {model.capabilities.includes("image") && <ImageOptionsFields options={model.imageOptions ?? defaultImageOptions(model.id)} onChange={(imageOptions) => setDraft((value) => ({ ...value, models: value.models.map((item) => item.id === model.id ? { ...item, imageOptions } : item) }))} />}
            </div>)}
          </section>
        </fieldset>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
      <footer className="settings-drawer-footer">
        <button type="button" className="settings-button" onClick={onClose} disabled={saving}>取消</button>
        <button type="submit" className="settings-button settings-primary" disabled={saving}>{saving ? "保存中…" : "保存渠道"}</button>
      </footer>
    </form>
    {pickerOpen && <ChannelModelPicker models={draft.models} onClose={() => setPickerOpen(false)} onPull={(signal) => modelSettingsApi.discoverModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey, channelId: channel?.id }, signal)} onConfirm={(ids) => {
      setDraft((value) => ({ ...value, models: [...value.models, ...ids.map((id) => ({ id, capabilities: [] }))] }));
      setPickerOpen(false);
    }} />}
  </dialog>;
}

function Preferences({ settings, onSave }: { settings: ModelSettingsView; onSave: (patch: Partial<ModelPreferences>) => Promise<void> }) {
  const [draft, setDraft] = useState(settings.preferences);
  const [saving, setSaving] = useState(false);
  const changed = capabilities.filter((capability) => choiceValue(draft[capability]) !== choiceValue(settings.preferences[capability]));
  const options = (capability: ModelCapability) => settings.channels.flatMap((channel) => channel.models
    .filter((model) => model.capabilities.includes(capability))
    .map((model) => ({ ref: { channelId: channel.id, modelId: model.id }, label: `${channel.name} · ${model.id}` })));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const patch: Partial<ModelPreferences> = {};
    for (const capability of changed) patch[capability] = draft[capability];
    setSaving(true);
    try { await onSave(patch); } finally { setSaving(false); }
  };
  return <form className="settings-preferences" onSubmit={submit}>
    <fieldset disabled={saving} className="settings-fields">
      {capabilities.map((capability) => {
        const choices = options(capability);
        return <label key={capability}>默认{capabilityLabels[capability]}模型
          <select value={choiceValue(draft[capability])} onChange={(event) => setDraft({ ...draft, [capability]: choices.find(({ ref }) => choiceValue(ref) === event.target.value)?.ref ?? null })}>
            <option value="">未设置</option>
            {choices.map(({ ref, label }) => <option key={choiceValue(ref)} value={choiceValue(ref)}>{label}</option>)}
          </select>
          <small>{capability === "image" ? "用于白底精修、创作板生图和图片编辑。" : "用于套图规划、爆品图反推和 OCR。"}</small>
        </label>;
      })}
    </fieldset>
    <button type="submit" className="settings-button settings-primary" disabled={saving || !changed.length}>{saving ? "保存中…" : "保存偏好"}</button>
  </form>;
}

export function ModelSettingsPage({ preferences, navigate }: { preferences: boolean; navigate: (path: string) => void }) {
  const [settings, setSettings] = useState<ModelSettingsView | null>(null);
  const [drawer, setDrawer] = useState<ModelChannel | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => {
    setError("");
    try { setSettings(await modelSettingsApi.get()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "加载配置失败"); }
  };
  useEffect(() => { void load(); }, []);

  const remove = async (channel: ModelChannel) => {
    if (!window.confirm(`删除渠道「${channel.name}」？`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try { setSettings(await modelSettingsApi.removeChannel(channel.id)); setNotice("渠道已删除"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "删除渠道失败"); }
    finally { setBusy(false); }
  };

  const savePreferences = async (patch: Partial<ModelPreferences>) => {
    setError("");
    setNotice("");
    try { setSettings(await modelSettingsApi.savePreferences(patch)); setNotice("偏好设置已保存"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存偏好失败"); }
  };

  const linkTo = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setError("");
    setNotice("");
    navigate(path);
  };

  return <AppShell
    activeNav="settings"
    navigate={navigate}
    crumbs={[{ label: "配置", to: "/settings" }, { label: preferences ? "偏好设置" : "模型渠道" }]}
    statusText={error ? "配置加载异常" : notice || "配置已同步"}
    statusTone={error ? "error" : "pass"}
  >
    <main className="settings-main">
      <h1>配置</h1>
      <nav className="settings-tabs" aria-label="配置页签">
        <a href="/settings" onClick={linkTo("/settings")} aria-current={!preferences ? "page" : undefined}>渠道</a>
        <a href="/settings/preferences" onClick={linkTo("/settings/preferences")} aria-current={preferences ? "page" : undefined}>偏好设置</a>
      </nav>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {notice && <p className="settings-notice" role="status">{notice}</p>}
      {!settings ? error ? <button className="settings-button" onClick={() => void load()}>重试</button> : <p role="status">正在读取配置…</p>
        : preferences ? <Preferences key={JSON.stringify(settings.preferences)} settings={settings} onSave={savePreferences} />
        : <section aria-labelledby="channels-title">
          <header className="settings-section-head">
            <div><h2 id="channels-title">模型渠道</h2><p>同一工作台实例共用这些渠道。</p></div>
            <button type="button" className="settings-button settings-primary" disabled={busy} onClick={() => setDrawer(null)}>新增渠道</button>
          </header>
          {settings.channels.length ? <ul className="settings-channels">{settings.channels.map((channel) => <li key={channel.id}>
            <div className="settings-channel-icon"><Icon name="sliders" /></div>
            <div className="settings-channel-detail">
              <h3>{channel.name}</h3>
              <p>{channel.baseUrl}</p>
              <ul className="settings-channel-meta"><li>OpenAI 兼容</li><li>{channel.models.length} 个模型</li></ul>
            </div>
            <div className="settings-channel-actions">
              <button type="button" className="settings-button" aria-label={`编辑 ${channel.name}`} disabled={busy} onClick={() => setDrawer(channel)}>编辑</button>
              <button type="button" className="settings-button settings-danger" aria-label={`删除 ${channel.name}`} disabled={busy} onClick={() => void remove(channel)}>删除</button>
            </div>
          </li>)}</ul> : <p className="settings-empty">暂无渠道。新增渠道后可在偏好设置中选择默认模型。</p>}
        </section>}
    </main>
    {drawer !== undefined && <ChannelDrawer channel={drawer} onClose={() => setDrawer(undefined)} onSave={async (input) => {
      setSettings(await modelSettingsApi.saveChannel(input, drawer?.id));
      setDrawer(undefined);
      setError("");
      setNotice("渠道已保存");
    }} />}
  </AppShell>;
}
