import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { capabilityLabels, defaultImageOptions, MODEL_CAPABILITIES, IMAGE_QUALITIES, type ImageOptions, type ChannelModel, type ModelCapability, type ModelChannelInput, type ModelChannelSnapshot, type ModelPreferences, type ModelSettingsView } from "../shared/model-settings.js";
import { parseProviderJson } from "./providers/provider-json.js";

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

function normalizeBaseUrl(value: unknown) {
  try {
    if (typeof value !== "string") throw new Error();
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new SettingsError("INVALID_MODEL_CHANNEL_URL", "请填写不含凭据、查询参数和片段的 HTTP(S) 接口地址");
  }
}

function providerBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.pathname === "/") url.pathname = "/v1";
  return url.href;
}

function resolveApiKey(input: unknown, baseUrl: string, previous?: StoredChannel) {
  const submitted = typeof input === "string" ? input.trim() : "";
  if (submitted && !/^[!-~]+$/.test(submitted)) throw new SettingsError("INVALID_MODEL_CHANNEL_KEY", "API Key 格式无效");
  const apiKey = submitted || (previous?.baseUrl === baseUrl ? previous.apiKey : "");
  if (!apiKey) throw new SettingsError("MODEL_CHANNEL_KEY_REQUIRED", "新增渠道或变更接口地址时，请填写 API Key");
  return apiKey;
}

function validateImageOptions(value: unknown): ImageOptions {
  const options = object(value);
  const validList = (items: unknown, pattern: RegExp): items is string[] => Array.isArray(items) && items.length > 0 && items.every((item) => typeof item === "string" && pattern.test(item));
  if (!validList(options.sizes, /^(1K|2K|4K)$/) || !validList(options.aspectRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/) || (options.sizeMode !== "tier" && options.sizeMode !== "pixels")) {
    throw new SettingsError("INVALID_IMAGE_OPTIONS", "请配置非空的分辨率档位（1K/2K/4K）、有效比例和尺寸模式");
  }
  const quality = IMAGE_QUALITIES.find((value) => value === options.quality);
  if (options.quality !== undefined && !quality) {
    throw new SettingsError("INVALID_IMAGE_OPTIONS", "请为图片编辑选择有效的出图质量");
  }
  return { sizes: [...new Set(options.sizes)], aspectRatios: [...new Set(options.aspectRatios)], sizeMode: options.sizeMode, ...(quality ? { quality } : {}) };
}

function validateChannel(value: unknown): ModelChannelInput {
  const body = object(value);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || body.protocol !== "openai-compatible") {
    throw new SettingsError("INVALID_MODEL_CHANNEL", "请填写渠道名称并选择 OpenAI 兼容协议");
  }
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  if (!Array.isArray(body.models)) throw new SettingsError("INVALID_CHANNEL_MODELS", "请填写渠道模型列表");
  const models = new Map<string, ChannelModel>();
  for (const entry of body.models) {
    const model = object(entry);
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || models.has(id) || !Array.isArray(model.capabilities) || !model.capabilities.length ||
      model.capabilities.some((value) => !MODEL_CAPABILITIES.includes(value))) {
      throw new SettingsError("INVALID_CHANNEL_MODELS", "同一渠道的模型 ID 必须非空且唯一，每个模型至少选择一种能力");
    }
    models.set(id, { id, capabilities: [...new Set<ModelCapability>(model.capabilities)], ...(model.imageOptions === undefined ? {} : { imageOptions: validateImageOptions(model.imageOptions) }) });
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  return { name, protocol: body.protocol, baseUrl, apiKey, models: [...models.values()] };
}

function assertReferences(state: ModelSettingsState, status: 400 | 409) {
  for (const capability of MODEL_CAPABILITIES) {
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
    preferences: { ...state.preferences, video: state.preferences.video ?? null },
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
    const model = channel.models.find((model) => model.id === ref.modelId)!;
    return { model: ref.modelId, apiKey: channel.apiKey, baseUrl: providerBaseUrl(channel.baseUrl), source,
      ...(capability === "image" ? { imageOptions: model.imageOptions ?? defaultImageOptions(model.id) } : {}),
    };
  }

  async request(method: string, path: string, input: unknown) {
    const requestId = randomUUID();
    try {
      const discovering = method === "POST" && path === "/api/model-settings/models";
      const data = discovering ? await this.discoverModels(input) : view(await this.handleRequest(method, path, input));
      return { status: method === "POST" && !discovering ? 201 : 200, body: { data, requestId } };
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      return { status: error.status, body: { error: { code: error.code, message: error.message }, requestId } };
    }
  }

  private async discoverModels(input: unknown) {
    const body = object(input);
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const previous = typeof body.channelId === "string"
      ? (await this.repository.read()).channels.find(({ id }) => id === body.channelId)
      : undefined;
    if (body.channelId !== undefined && !previous) throw new SettingsError("MODEL_CHANNEL_NOT_FOUND", "渠道不存在", 404);
    const apiKey = resolveApiKey(body.apiKey, baseUrl, previous);
    const signal = AbortSignal.timeout(15_000);
    const unavailable = new SettingsError("MODEL_LIST_UNAVAILABLE", "无法拉取模型列表，请检查接口地址或手动添加模型", 502);
    const invalid = new SettingsError("INVALID_MODEL_LIST", "上游返回的模型列表格式无效，请手动添加模型", 502);
    try {
      const response = await fetch(`${providerBaseUrl(baseUrl).replace(/\/+$/, "")}/models`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
          throw new SettingsError("MODEL_LIST_AUTH_FAILED", "上游拒绝访问模型列表，请检查 API Key 或手动添加模型", 502);
        }
        if (response.status === 404 || response.status === 405) {
          throw new SettingsError("MODEL_LIST_UNSUPPORTED", "上游未提供模型列表，请检查接口地址或手动添加模型", 502);
        }
        throw unavailable;
      }
      const text = await response.text();
      let payload: { data?: unknown } | null;
      try { payload = parseProviderJson(text, apiKey, invalid.code) as typeof payload; }
      catch { throw invalid; }
      if (!Array.isArray(payload?.data)) throw invalid;
      const ids = new Set<string>();
      for (const model of payload.data) {
        if (typeof model?.id === "string" && model.id.trim()) ids.add(model.id.trim());
      }
      if (payload.data.length && !ids.size) throw invalid;
      return { modelIds: [...ids] };
    } catch (error) {
      if (error instanceof SettingsError) throw error;
      if (signal.aborted) throw new SettingsError("MODEL_LIST_TIMEOUT", "拉取模型列表超时，请重试或手动添加模型", 504);
      throw unavailable;
    }
  }

  private async handleRequest(method: string, path: string, input: unknown) {
    if (method === "GET" && path === "/api/model-settings") return this.repository.read();
    if (method === "PATCH" && path === "/api/model-settings/preferences") {
      const body = object(input);
      return this.repository.update((state) => {
        for (const capability of MODEL_CAPABILITIES) {
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
        const apiKey = resolveApiKey(submitted.apiKey, submitted.baseUrl, previous);
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
