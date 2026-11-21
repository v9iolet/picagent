import type { PipelineRepository, SuitePipelineRun } from "../types.js";

export class MemoryPipelineRepository implements PipelineRepository {
  private runs = new Map<string, SuitePipelineRun>();
  private keys = new Map<string, string>();

  async createRun(run: SuitePipelineRun) {
    const key = `${run.suiteId}:${run.idempotencyKey}`;
    const existing = this.keys.get(key);
    if (existing) return { run: this.runs.get(existing)!, duplicate: true };
    this.runs.set(run.id, run);
    this.keys.set(key, run.id);
    return { run, duplicate: false };
  }
  async getRun(id: string) { return this.runs.get(id) ?? null; }
  async getLatestRun(suiteId: string) { return (await this.listRuns(suiteId))[0] ?? null; }
  async listRuns(suiteId: string) { return [...this.runs.values()].filter((run) => run.suiteId === suiteId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async updateRun(id: string, patch: Partial<Pick<SuitePipelineRun, "status" | "currentPhase" | "config" | "errorCode" | "errorMessage" | "updatedAt" | "completedAt">>) {
    const current = this.runs.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.runs.set(id, next);
    return next;
  }
}
