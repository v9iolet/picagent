import type {
  PlanSnapshot,
  StructurePlanV2,
  SuiteTask,
  TaskGenerationAttempt,
  TaskGenerationBatch,
  TaskResultSlot,
  TaskImageVersion,
} from "./types.js";

export function planSnapshotView(snapshot: PlanSnapshot) {
  return {
    id: snapshot.id,
    suiteId: snapshot.suiteId,
    revisionNumber: snapshot.revisionNumber,
    revisionKind: snapshot.revisionKind,
    parentSnapshotId: snapshot.parentSnapshotId,
    templateVersionId: snapshot.templateVersionId,
    dynamicInput: snapshot.dynamicInput,
    humanInput: snapshot.humanInput,
    chunks: snapshot.chunks.map(({ content: _content, ...chunk }) => chunk),
    inputImageIds: snapshot.inputImageIds,
    baseVersionIds: snapshot.baseVersionIds,
    provider: snapshot.provider,
    schemaVersion: snapshot.schemaVersion,
    items: snapshot.items,
    phase: snapshot.phase ?? "legacy_plan",
    confirmationStatus: snapshot.confirmationStatus ?? "confirmed",
    confirmationMode: snapshot.confirmationMode ?? "human",
    confirmedAt: snapshot.confirmedAt ?? null,
    structure: snapshot.structure ?? null,
    categoryOutputs: snapshot.categoryOutputs ?? {},
    createdAt: snapshot.createdAt,
  };
}

export function isStructurePlanV2(structure: PlanSnapshot["structure"]): structure is StructurePlanV2 {
  return Boolean(structure && "mainAllocation" in structure && "status" in structure);
}

export function taskView(task: SuiteTask) {
  return task;
}
export function taskAttemptView(attempt: TaskGenerationAttempt) {
  return attempt;
}
export function taskBatchView(batch: TaskGenerationBatch) {
  return batch;
}
export function taskSlotView(slot: TaskResultSlot) {
  return slot;
}
export function taskVersionView(version: TaskImageVersion) {
  return version;
}
