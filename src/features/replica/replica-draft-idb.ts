import { createIdbBlobStore, type KeepBlobKeysInput } from "../../lib/draft-storage";

export const REPLICA_DRAFT_IDB_NAME = "picagent-replica-draft";
export const REPLICA_DRAFT_IDB_VERSION = 1;
export const REPLICA_DRAFT_BLOB_STORE = "blobs";

export type { KeepBlobKeysInput } from "../../lib/draft-storage";

export interface ReplicaDraftBlobStorage {
  putBlob(key: string, blob: Blob): Promise<boolean>;
  getBlobs(keys: readonly string[]): Promise<Map<string, Blob>>;
  deleteBlob(key: string): Promise<void>;
  clearBlobs(): Promise<void>;
  pruneBlobs(keepKeys: KeepBlobKeysInput): Promise<void>;
}

export function createIndexedDbBlobStorage(
  dbName = REPLICA_DRAFT_IDB_NAME,
  storeName = REPLICA_DRAFT_BLOB_STORE,
  idbFactory?: IDBFactory | null,
): ReplicaDraftBlobStorage {
  return createIdbBlobStore({ dbName, storeName, version: REPLICA_DRAFT_IDB_VERSION, idbFactory });
}

export const replicaDraftBlobStorage = createIndexedDbBlobStorage();
