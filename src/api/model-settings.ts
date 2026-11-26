import { getJson, postJson, patchJson, putJson, deleteJson } from "./http.js";

import type { ModelChannelInput, ModelPreferences, ModelSettingsView } from "../../shared/model-settings";

const settingsPath = "/api/model-settings";
export const modelSettingsApi = {
  get: () => getJson<ModelSettingsView>(settingsPath),
  discoverModels: (input: Pick<ModelChannelInput, "baseUrl" | "apiKey"> & { channelId?: string }, signal: AbortSignal) =>
    postJson<{ modelIds: string[] }>(`${settingsPath}/models`, input, { signal }),
  saveChannel: (input: ModelChannelInput, id?: string) => id
    ? putJson<ModelSettingsView>(`${settingsPath}/channels/${encodeURIComponent(id)}`, input)
    : postJson<ModelSettingsView>(`${settingsPath}/channels`, input),
  removeChannel: (id: string) => deleteJson<ModelSettingsView>(`${settingsPath}/channels/${encodeURIComponent(id)}`),
  savePreferences: (preferences: Partial<ModelPreferences>) => patchJson<ModelSettingsView>(`${settingsPath}/preferences`, preferences),
};
