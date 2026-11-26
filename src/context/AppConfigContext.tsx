import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ApiPlatformProfile } from "../api/types";
import { createConfigCache } from "./app-config-cache";

function createAppConfig() {
  const platforms = createConfigCache(async () => (await import("../api/suites")).suiteApi.listPlatforms());
  const modelSettings = createConfigCache(async () => (await import("../api/model-settings")).modelSettingsApi.get());
  return { platforms, modelSettings, refreshPlatforms: platforms.refresh, refreshModelSettings: modelSettings.refresh };
}

const AppConfigContext = createContext<ReturnType<typeof createAppConfig> | null>(null);

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [config] = useState(createAppConfig);
  return <AppConfigContext.Provider value={config}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig() {
  const config = useContext(AppConfigContext);
  if (!config) throw new Error("useAppConfig requires AppConfigProvider");
  return config;
}

function useConfigSnapshot<T>(cache: ReturnType<typeof createConfigCache<T>>) {
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  useEffect(() => { void cache.load(); }, [cache]);
  return snapshot;
}

const emptyPlatforms: ApiPlatformProfile[] = [];

export function usePlatforms() {
  const config = useAppConfig();
  const { data, loading, error } = useConfigSnapshot(config.platforms);
  return { platforms: data ?? emptyPlatforms, loading, error, refreshPlatforms: config.refreshPlatforms };
}

export function useModelSettings() {
  const config = useAppConfig();
  const { data, loading, error } = useConfigSnapshot(config.modelSettings);
  return { modelSettings: data, loading, error, refreshModelSettings: config.refreshModelSettings };
}
