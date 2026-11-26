import type { ApiTaskVersion } from "../../api/client";

export function versionGenerationPrompt(snapshot: ApiTaskVersion["promptSnapshot"], fallback = "") {
  const value = snapshot?.finalPrompt ?? snapshot?.prompt;
  return typeof value === "string" && value.trim() ? value : fallback;
}
