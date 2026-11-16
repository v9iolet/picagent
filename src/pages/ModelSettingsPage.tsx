import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { capabilityLabels, type ModelCapability, type ModelChannel, type ModelChannelInput, type ModelPreferences, type ModelReference, type ModelSettingsView } from "../../shared/model-settings";
import { modelSettingsApi } from "../api/client";
import { Icon } from "./shared";
import "./ModelSettingsPage.css";

const capabilities = ["image", "vision"] as const;
const emptyChannel = (): ModelChannelInput => ({ name: "", protocol: "openai-compatible", baseUrl: "", apiKey: "", models: [] });
const choiceValue = (ref: ModelReference | null) => ref ? JSON.stringify([ref.channelId, ref.modelId]) : "";

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

  useEffect(() => { dialog.current?.showModal(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try { await onSave(draft); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存渠道失败"); }
    finally { setSaving(false); }
  };

  const patchModel = (index: number, patch: Partial<ModelChannelInput["models"][number]>) => {
    setDraft((value) => ({ ...value, models: value.models.map((model, position) => position === index ? { ...model, ...patch } : model) }));
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
            <header className="settings-section-head"><h3 id="channel-models-title">渠道模型</h3><button type="button" className="settings-button" onClick={() => setDraft({ ...draft, models: [...draft.models, { id: "", capabilities: [] }] })}>添加模型</button></header>
            {draft.models.map((model, index) => <fieldset className="settings-model" key={index}>
              <legend>模型 {index + 1}</legend>
              <div className="settings-model-input">
                <label>模型 ID<input required placeholder="填写服务商提供的模型 ID" value={model.id} onChange={(event) => patchModel(index, { id: event.target.value })} /></label>
                <button type="button" className="settings-button settings-danger" aria-label={`移除模型 ${index + 1}`} onClick={() => setDraft({ ...draft, models: draft.models.filter((_, position) => position !== index) })}>移除</button>
              </div>
              <div className="settings-capabilities">{capabilities.map((capability) => <label key={capability}>
                <input type="checkbox" checked={model.capabilities.includes(capability)} onChange={(event) => patchModel(index, { capabilities: event.target.checked ? [...model.capabilities, capability] : model.capabilities.filter((value) => value !== capability) })} />
                {capabilityLabels[capability]}
              </label>)}</div>
            </fieldset>)}
          </section>
        </fieldset>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </div>
      <footer className="settings-drawer-footer">
        <button type="button" className="settings-button" onClick={onClose} disabled={saving}>取消</button>
        <button type="submit" className="settings-button settings-primary" disabled={saving}>{saving ? "保存中…" : "保存渠道"}</button>
      </footer>
    </form>
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

  return <div className="start-shell">
    <header className="start-topbar">
      <a className="start-brand" href="/suites/new" onClick={linkTo("/suites/new")}><img src="/logo.png" alt="" width={36} height={36} /><strong>PicAgent</strong></a>
      <div className="start-context"><span>内部图片生产</span><i>/</i><strong>配置</strong></div>
    </header>
    <aside className="start-sidebar" aria-label="主导航">
      <a className="start-nav" href="/suites/new" onClick={linkTo("/suites/new")}><Icon name="sparkles" /><span>创建</span></a>
      <a className="start-nav" href="/style-library" onClick={linkTo("/style-library")}><Icon name="library" /><span>风格库</span></a>
      <a className="start-nav active" href="/settings" aria-current="page" onClick={linkTo("/settings")}><Icon name="sliders" /><span>配置</span></a>
      <span className="start-nav-spacer" />
    </aside>
    <main className="start-main settings-main">
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
  </div>;
}
