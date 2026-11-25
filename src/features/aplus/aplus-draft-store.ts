import type { AplusDraft, AplusStudioState } from "./aplus-studio";

const STORAGE_KEY = "picagent:aplus:workspace-v1";

interface AplusWorkspace {
  routeKey: string;
  suiteId: string | null;
  draft: AplusDraft;
}

let workspace: AplusWorkspace | null = null;
let batch: AplusStudioState | null = null;

export function readAplusWorkspace(): AplusWorkspace | null {
  if (workspace) return workspace;
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<AplusWorkspace> | null;
      if (typeof parsed?.routeKey === "string" && parsed.draft?.config && Array.isArray(parsed.draft.images)) {
        workspace = parsed as AplusWorkspace;
      }
    }
  } catch {
    // The in-memory workspace still works when session storage is unavailable.
  }
  return workspace;
}

export function saveAplusWorkspace(value: AplusWorkspace) {
  workspace = value;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // The in-memory workspace still works when session storage is unavailable.
  }
}

export function readAplusBatch(suiteId: string | undefined) {
  return batch?.suite.id === suiteId ? batch : null;
}

export function saveAplusBatch(state: AplusStudioState | null) {
  batch = state;
}

export function clearAplusWorkspace() {
  workspace = null;
  batch = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Session storage is optional.
  }
}
