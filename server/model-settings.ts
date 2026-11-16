import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { capabilityLabels, type ChannelModel, type ModelCapability, type ModelChannelInput, type ModelChannelSnapshot, type ModelPreferences, type ModelSettingsView } from "../shared/model-settings.js";

interface StoredChannel extends ModelChannelInput { id: string }

export interface ModelSettingsState {
  channels: StoredChannel[];
  preferences: ModelPreferences;
}

interface SettingsRepository {
  read(): Promise<ModelSettingsState>;
  update(change: (state: ModelSettingsState) => ModelSettingsState): Promise<ModelSettingsState>;
}

class SettingsError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsError("INVALID_MODEL_SETTINGS", "请提交有效的配置");
  }
  return value as Record<string, unknown>;
}

function validateChannel(value: unknown): ModelChannelInput {
  const body = object(value);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || body.protocol !== "openai-compatible") {
    throw new SettingsError("INVALID_MODEL_CHANNEL", "请填写渠道名称并选择 OpenAI 兼容协议");
  }
  let url: URL;
  try {
    if (typeof body.baseUrl !== "string") throw new Error();
    url = new URL(body.baseUrl.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new SettingsError("INVALID_MODEL_CHANNEL_URL", "请填写不含凭据、查询参数和片段的 HTTP(S) 接口地址");
  }
  if (!Array.isArray(body.models)) throw new SettingsError("INVALID_CHANNEL_MODELS", "请填写渠道模型列表");
  const models = new Map<string, ChannelModel>();
  for (const entry of body.models) {
    const model = object(entry);
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || models.has(id) || !Array.isArray(model.capabilities) || !model.capabilities.length ||
      model.capabilities.some((value: unknown) => value !== "image" && value !== "vision")) {
      throw new SettingsError("INVALID_CHANNEL_MODELS", "同一渠道的模型 ID 必须非空且唯一，每个模型至少选择一种能力");
    }
    models.set(id, { id, capabilities: [...new Set<ModelCapability>(model.capabilities)] });
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey && !/^[!-~]+$/.test(apiKey)) throw new SettingsError("INVALID_MODEL_CHANNEL_KEY", "API Key 格式无效");
  return { name, protocol: body.protocol, baseUrl: url.href.replace(/\/+$/, ""), apiKey, models: [...models.values()] };
}

function assertReferences(state: ModelSettingsState, status: 400 | 409) {
  for (const capability of ["image", "vision"] as const) {
    const ref = state.preferences[capability];
    if (!ref) continue;
    const channel = state.channels.find((item) => item.id === ref.channelId);
    if (!channel?.models.some((model) => model.id === ref.modelId && model.capabilities.includes(capability))) {
      const label = capabilityLabels[capability];
      throw new SettingsError("INVALID_DEFAULT_MODEL", status === 409
        ? `请先在偏好设置中切换或清除默认${label}模型`
        : `请选择支持${label}能力的渠道模型`, status);
    }
  }
}

function view(state: ModelSettingsState): ModelSettingsView {
  return {
    channels: state.channels.map(({ apiKey, ...channel }) => ({ ...channel, hasApiKey: Boolean(apiKey) })),
    preferences: state.preferences,
  };
}

export class ModelSettings {
  constructor(private readonly repository: SettingsRepository) {}

  async resolve(capability: ModelCapability) {
    const state = await this.repository.read();
    const ref = state.preferences[capability];
    const channel = state.channels.find((item) => item.id === ref?.channelId);
    if (!ref || !channel?.apiKey || !channel.models.some((model) => model.id === ref.modelId && model.capabilities.includes(capability))) return null;
    const source: ModelChannelSnapshot = { channelId: channel.id, channelName: channel.name, baseUrl: channel.baseUrl };
    const url = new URL(channel.baseUrl);
    if (url.pathname === "/") url.pathname = "/v1";
    return { model: ref.modelId, apiKey: channel.apiKey, baseUrl: url.href, source };
  }

  async request(method: string, path: string, input: unknown) {
    const requestId = randomUUID();
    try {
      const result = await this.handleRequest(method, path, input);
      return { status: method === "POST" ? 201 : 200, body: { data: view(result), requestId } };
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      return { status: error.status, body: { error: { code: error.code, message: error.message }, requestId } };
    }
  }

  private async handleRequest(method: string, path: string, input: unknown) {
    if (method === "GET" && path === "/api/model-settings") return this.repository.read();
    if (method === "PATCH" && path === "/api/model-settings/preferences") {
      const body = object(input);
      return this.repository.update((state) => {
        for (const capability of ["image", "vision"] as const) {
          const value = body[capability];
          if (value === undefined) continue;
          if (value === null) { state.preferences[capability] = null; continue; }
          const { channelId, modelId } = object(value);
          if (typeof channelId !== "string" || typeof modelId !== "string") {
            throw new SettingsError("INVALID_DEFAULT_MODEL", "请选择有效的渠道模型");
          }
          state.preferences[capability] = { channelId, modelId };
        }
        assertReferences(state, 400);
        return state;
      });
    }
    const match = path.match(/^\/api\/model-settings\/channels\/([^/]+)$/);
    const creating = method === "POST" && path === "/api/model-settings/channels";
    if (!creating && !(match && (method === "DELETE" || method === "PUT"))) {
      throw new SettingsError("NOT_FOUND", "请求不存在", 404);
    }
    const submitted = method === "DELETE" ? null : validateChannel(input);
    return this.repository.update((state) => {
      const index = state.channels.findIndex((channel) => channel.id === match?.[1]);
      const previous = state.channels[index];
      if (!creating && !previous) throw new SettingsError("MODEL_CHANNEL_NOT_FOUND", "渠道不存在", 404);
      if (submitted) {
        const apiKey = submitted.apiKey || (previous?.baseUrl === submitted.baseUrl ? previous.apiKey : "");
        if (!apiKey) throw new SettingsError("MODEL_CHANNEL_KEY_REQUIRED", "新增渠道或变更接口地址时，请填写 API Key");
        const channel = { ...submitted, id: previous?.id ?? randomUUID(), apiKey };
        if (creating) state.channels.push(channel);
        else state.channels[index] = channel;
      } else state.channels.splice(index, 1);
      assertReferences(state, 409);
      return state;
    });
  }
}

export class PostgresModelSettingsRepository implements SettingsRepository {
  constructor(private readonly pool: Pool) {}

  async read() {
    const result = await this.pool.query<{ state: ModelSettingsState }>("SELECT state FROM suite_workbench.model_settings WHERE singleton");
    return result.rows[0].state;
  }

  async update(change: (state: ModelSettingsState) => ModelSettingsState) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ state: ModelSettingsState }>("SELECT state FROM suite_workbench.model_settings WHERE singleton FOR UPDATE");
      const state = change(result.rows[0].state);
      await client.query("UPDATE suite_workbench.model_settings SET state=$1 WHERE singleton", [JSON.stringify(state)]);
      await client.query("COMMIT");
      return state;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
