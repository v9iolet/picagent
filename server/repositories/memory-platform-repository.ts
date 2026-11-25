import { defaultDetailSizePresets } from "../../shared/aplus.js";
import type { PlatformProfile, PlatformRepository } from "../types.js";

type PlatformSeed = Omit<PlatformProfile, "detailSizePresets"> & Partial<Pick<PlatformProfile, "detailSizePresets">> & { enabled?: boolean };

export class MemoryPlatformRepository implements PlatformRepository {
  private readonly profiles: PlatformProfile[];

  constructor(profiles: readonly PlatformSeed[]) {
    this.profiles = profiles
      .filter(({ enabled }) => enabled !== false)
      .map(({ enabled: _enabled, ...profile }) => ({
        ...profile,
        detailSizePresets: profile.detailSizePresets ?? defaultDetailSizePresets(profile.code, profile.marketScope),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async listEnabled(): Promise<PlatformProfile[]> {
    return [...this.profiles];
  }

  async find(value: string): Promise<PlatformProfile | null> {
    const key = value.trim();
    return this.profiles.find(({ code, name }) => key === code || key === name || key.startsWith(`${name} `)) ?? null;
  }
}
