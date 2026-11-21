import type { PipelineRepository, SuitePipelinePhase, SuitePipelineRun } from "../types.js";

export class MemoryPipelineRepository implements PipelineRepository {
  private runs = new Map<string, SuitePipelineRun>();
  private keys = new Map<string, string>();

  async createRun(run: SuitePipelineRun) {
    const key = `${run.suiteId}:${run.idempotencyKey}`;
    const existing = this.keys.get(key);
    if (existing) return { run: this.runs.get(existing)!, duplicate: true };
    if ([...this.runs.values()].some((other) => other.suiteId === run.suiteId && other.status === "running")) throw new Error("PIPELINE_ALREADY_RUNNING");
    this.runs.set(run.id, run);
    this.keys.set(key, run.id);
    return { run, duplicate: false };
  }
  async getRun(id: string) { return this.runs.get(id) ?? null; }
  async resumeRun(previous: SuitePipelineRun, key: string, phase: SuitePipelinePhase, config: SuitePipelineRun["config"]) {
    const current = this.runs.get(previous.id);
    if (!current || current.status !== previous.status || current.resumeCount !== previous.resumeCount ||
        current.resumeKeys?.includes(key) || current.lastResumeKey === key ||
        [...this.runs.values()].some((other) => other.suiteId === previous.suiteId && other.status === "running")) return null;
    const next: SuitePipelineRun = {
      ...current, config, currentPhase: phase, status: "running", errorCode: null, errorMessage: null, completedAt: null,
      resumeCount: (current.resumeCount ?? 0) + 1, lastResumeKey: key, resumeKeys: [...(current.resumeKeys ?? []), key], updatedAt: new Date().toISOString(),
    };
    this.runs.set(next.id, next);
    return next;
  }
  async getLatestRun(suiteId: string) { return (await this.listRuns(suiteId))[0] ?? null; }
  async listRuns(suiteId: string) { return [...this.runs.values()].filter((run) => run.suiteId === suiteId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async updateRun(id: string, patch: Partial<Pick<SuitePipelineRun, "status" | "currentPhase" | "resumeCount" | "lastResumeKey" | "structureSnapshotId" | "taskIds" | "config" | "errorCode" | "errorMessage" | "updatedAt" | "completedAt">>) {
    const current = this.runs.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.runs.set(id, next);
    return next;
  }
}
