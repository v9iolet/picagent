export type ModelCapability = "image" | "vision";

export interface ChannelModel {
  id: string;
  capabilities: ModelCapability[];
}

export interface ModelReference {
  channelId: string;
  modelId: string;
}

export interface ModelChannel {
  id: string;
  name: string;
  protocol: "openai-compatible";
  baseUrl: string;
  models: ChannelModel[];
  hasApiKey: boolean;
}

export type ModelPreferences = Record<ModelCapability, ModelReference | null>;
export interface ModelSettingsView {
  channels: ModelChannel[];
  preferences: ModelPreferences;
}

export interface ModelChannelInput extends Omit<ModelChannel, "id" | "hasApiKey"> {
  apiKey: string;
}

export interface ModelChannelSnapshot {
  channelId: string;
  channelName: string;
  baseUrl: string;
}

export const capabilityLabels = { image: "生图", vision: "多模态" } as const;
