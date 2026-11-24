export const REPLICA_DRAFT_IDB_NAME = "picagent-replica-draft";
export const REPLICA_DRAFT_IDB_VERSION = 1;
export const REPLICA_DRAFT_BLOB_STORE = "blobs";

export interface ReplicaDraftBlobStorage {
  putBlob(key: string, blob: Blob): Promise<boolean>;
  getBlobs(keys: readonly string[]): Promise<Map<string, Blob>>;
  deleteBlob(key: string): Promise<void>;
  clearBlobs(): Promise<void>;
  pruneBlobs(keepKeys: ReadonlySet<string>): Promise<void>;
}

function isBlobLike(value: unknown): value is Blob {
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

export function createIndexedDbBlobStorage(
  dbName = REPLICA_DRAFT_IDB_NAME,
  storeName = REPLICA_DRAFT_BLOB_STORE,
): ReplicaDraftBlobStorage {
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      let idb: IDBFactory | undefined;
      try {
        idb = globalThis.indexedDB;
      } catch {
        resolve(null);
        return;
      }
      if (!idb) {
        resolve(null);
        return;
      }

      let request: IDBOpenDBRequest;
      try {
        request = idb.open(dbName, REPLICA_DRAFT_IDB_VERSION);
      } catch {
        resolve(null);
        return;
      }

      request.onupgradeneeded = () => {
        try {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName);
          }
        } catch {
          // Handled by onerror/onabort.
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        dbPromise = null;
        resolve(null);
      };

      request.onblocked = () => {
        dbPromise = null;
        resolve(null);
      };
    });

    return dbPromise.then((db) => {
      if (!db) dbPromise = null;
      return db;
    });
  }

  return {
    async putBlob(key: string, blob: Blob): Promise<boolean> {
      const db = await openDb();
      if (!db) return false;
      return new Promise<boolean>((resolve) => {
        try {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          store.put(blob, key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    },

    async getBlobs(keys: readonly string[]): Promise<Map<string, Blob>> {
      const result = new Map<string, Blob>();
      if (!keys.length) return result;
      const db = await openDb();
      if (!db) return result;
      return new Promise<Map<string, Blob>>((resolve) => {
        try {
          const tx = db.transaction(storeName, "readonly");
          const store = tx.objectStore(storeName);
          for (const key of keys) {
            const req = store.get(key);
            req.onsuccess = () => {
              if (isBlobLike(req.result)) {
                result.set(key, req.result);
              }
            };
          }
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => resolve(new Map());
          tx.onabort = () => resolve(new Map());
        } catch {
          resolve(new Map());
        }
      });
    },

    async deleteBlob(key: string): Promise<void> {
      const db = await openDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(storeName, "readwrite");
          tx.objectStore(storeName).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    async clearBlobs(): Promise<void> {
      const db = await openDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(storeName, "readwrite");
          tx.objectStore(storeName).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    async pruneBlobs(keepKeys: ReadonlySet<string>): Promise<void> {
      if (keepKeys.size === 0) {
        await this.clearBlobs();
        return;
      }
      const db = await openDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          const keysReq = store.getAllKeys();
          keysReq.onsuccess = () => {
            for (const key of keysReq.result) {
              if (typeof key === "string" && !keepKeys.has(key)) {
                store.delete(key);
              }
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };
}

export const replicaDraftBlobStorage = createIndexedDbBlobStorage();
