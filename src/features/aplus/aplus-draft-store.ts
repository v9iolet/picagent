import { createWebStorageStore } from "../../lib/draft-storage";
import type { AplusDraft, AplusStudioState } from "./aplus-studio";

const STORAGE_KEY = "picagent:aplus:workspace-v1";

interface AplusWorkspace {
  routeKey: string;
  suiteId: string | null;
  draft: AplusDraft;
}

let workspace: AplusWorkspace | null = null;
let batch: AplusStudioState | null = null;

const workspaceStorage = createWebStorageStore<AplusWorkspace>({
  storage: "sessionStorage",
  key: STORAGE_KEY,
  decode(raw) {
    const saved = raw as Partial<AplusWorkspace> | null;
    return typeof saved?.routeKey === "string" && saved.draft?.config && Array.isArray(saved.draft.images)
      ? saved as AplusWorkspace
      : null;
  },
});

export function readAplusWorkspace(): AplusWorkspace | null {
  workspace ??= workspaceStorage.read();
  return workspace;
}

export function saveAplusWorkspace(value: AplusWorkspace) {
  workspace = value;
  workspaceStorage.write(value);
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
  workspaceStorage.remove();
}
