import type { ReplicaProductImage, ReplicaReference, ReplicaRepository } from "../types.js";

function normalizeReference(ref: ReplicaReference): ReplicaReference {
  return {
    ...ref,
    remark: ref.remark ?? "",
  };
}

export class MemoryReplicaRepository implements ReplicaRepository {
  private readonly references = new Map<string, ReplicaReference[]>();
  private readonly products = new Map<string, ReplicaProductImage[]>();

  async saveReferences(suiteId: string, references: ReplicaReference[]): Promise<ReplicaReference[]> {
    const existing = this.references.get(suiteId);
    if (existing && existing.length > 0) return existing.map(normalizeReference);
    const normalized = [...references]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((ref) => normalizeReference({ ...ref, suiteId }));
    this.references.set(suiteId, normalized);
    return normalized.map(normalizeReference);
  }

  async listReferences(suiteId: string): Promise<ReplicaReference[]> {
    return (this.references.get(suiteId) ?? [])
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .map(normalizeReference);
  }

  async getReference(suiteId: string, referenceId: string): Promise<ReplicaReference | null> {
    const found = (this.references.get(suiteId) ?? []).find((ref) => ref.id === referenceId);
    return found ? normalizeReference(found) : null;
  }

  async saveProductImages(suiteId: string, products: ReplicaProductImage[]): Promise<ReplicaProductImage[]> {
    const existing = this.products.get(suiteId);
    if (existing && existing.length > 0) return existing.map((item) => ({ ...item }));
    const normalized = [...products]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((item) => ({ ...item, suiteId }));
    this.products.set(suiteId, normalized);
    return normalized.map((item) => ({ ...item }));
  }

  async listProductImages(suiteId: string): Promise<ReplicaProductImage[]> {
    return (this.products.get(suiteId) ?? [])
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((item) => ({ ...item }));
  }
}
