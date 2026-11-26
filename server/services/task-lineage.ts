import { storeAplusDelivery } from "../aplus/aplus-image.js";
import { dataOf } from "../api-response.js";
import type { DeliveryEditChildLike } from "../../shared/workbench-delivery.js";
import type { SuiteTask } from "../types.js";
import type { StudioDependencies } from "../app-dependencies.js";

export function createTaskLineage(deps: StudioDependencies) {
  const loadSuiteImageEditChildren = async (tasks: SuiteTask[]): Promise<DeliveryEditChildLike[]> => {
    if (!deps.imageEditorApi) return [];
    const response = await deps.imageEditorApi.request("GET", "/api/image-editor/tasks");
    const data = dataOf(response);
    if (response.status !== 200 || !Array.isArray(data)) return [];
    const all = data as DeliveryEditChildLike[];
    const allowed = new Set(tasks.map((task) => task.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of all) {
        const taskId = typeof child.task?.id === "string" ? child.task.id : "";
        const sourceCardId = typeof child.task?.sourceCardId === "string" ? child.task.sourceCardId : "";
        if (taskId && sourceCardId && allowed.has(sourceCardId) && !allowed.has(taskId)) { allowed.add(taskId); changed = true; }
      }
    }
    return all.filter((child) => typeof child.task?.id === "string" && allowed.has(child.task.id));
  };

  const clearReplicaCardFinalLocks = async (task: SuiteTask) => {
    if (!deps.taskRepository || task.originKind !== "replica") return;
    await deps.taskRepository.clearFinalVersion?.(task.id);
    if (!deps.imageEditorApi?.clearFinalVersions) return;
    const children = await loadSuiteImageEditChildren([task]);
    const childIds = children
      .map((child) => (typeof child.task?.id === "string" ? child.task.id : ""))
      .filter(Boolean);
    if (childIds.length) {
      await deps.imageEditorApi.clearFinalVersions(childIds);
    }
  };

  const resolveRootTaskForEditCard = async (sourceCardId: string): Promise<SuiteTask | null> => {
    if (!deps.taskRepository || !sourceCardId) return null;
    const direct = await deps.taskRepository.getTask(sourceCardId);
    if (direct) return direct;
    if (!deps.imageEditorApi) return null;
    const response = await deps.imageEditorApi.request("GET", "/api/image-editor/tasks");
    const data = dataOf(response);
    if (response.status !== 200 || !Array.isArray(data)) return null;
    const childById = new Map<string, string>();
    for (const entry of data as DeliveryEditChildLike[]) {
      const id = typeof entry.task?.id === "string" ? entry.task.id : "";
      const parent = typeof entry.task?.sourceCardId === "string" ? entry.task.sourceCardId : "";
      if (id && parent) childById.set(id, parent);
    }
    const visited = new Set<string>();
    let current = sourceCardId;
    while (current && !visited.has(current)) {
      visited.add(current);
      const next = childById.get(current);
      if (!next) break;
      const root = await deps.taskRepository.getTask(next);
      if (root) return root;
      current = next;
    }
    return null;
  };

  deps.imageEditorApi?.setOnVersionCompleted?.(async (childTask, generated) => {
    const rootTask = await resolveRootTaskForEditCard(childTask.sourceCardId);
    if (rootTask?.originKind === "replica") {
      await clearReplicaCardFinalLocks(rootTask);
    }
    if (rootTask?.originKind === "aplus" && rootTask.sizePreset) {
      return storeAplusDelivery(deps.storage, rootTask.sizePreset, generated, generated.objectKey);
    }
  });
  return { loadSuiteImageEditChildren, clearReplicaCardFinalLocks };
}
