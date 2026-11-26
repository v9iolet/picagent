export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type StorageSource = StorageLike | "sessionStorage" | "localStorage" | null;

interface StorageLocation {
  storage: StorageSource;
  key: string;
}

type ReadResult<T> =
  | { status: "ok"; value: T }
  | { status: "missing" | "unreadable"; value: null };

function storageEntry<T>(
  { storage, key }: StorageLocation,
  parse: (raw: string) => T | null,
  stringify: (value: T) => string | undefined,
) {
  function resolveStorage() {
    if (typeof storage !== "string") return storage;
    return typeof window === "undefined" ? null : window[storage];
  }

  function readResult(): ReadResult<T> {
    try {
      const target = resolveStorage();
      if (!target) return { status: "unreadable", value: null };
      const raw = target.getItem(key);
      if (raw === null) return { status: "missing", value: null };
      const value = parse(raw);
      return value === null ? { status: "unreadable", value: null } : { status: "ok", value };
    } catch {
      return { status: "unreadable", value: null };
    }
  }

  return {
    readResult,
    read: () => readResult().value,
    write(value: T): boolean {
      try {
        const target = resolveStorage();
        if (!target) return false;
        const raw = stringify(value);
        if (raw === undefined) return false;
        target.setItem(key, raw);
        return true;
      } catch {
        // Quota and privacy errors leave the last persisted draft intact.
        return false;
      }
    },
    remove(): boolean {
      try {
        const target = resolveStorage();
        if (!target) return false;
        target.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// Last-suite IDs predate JSON draft payloads and are stored as unquoted text.
export function createTextStorageStore(options: StorageLocation) {
  return storageEntry<string>(options, (text) => text, (text) => text);
}

interface WebStorageOptions<T> extends StorageLocation {
  decode: (data: unknown) => T | null;
  version?: number;
  migrate?: (data: unknown) => unknown;
}

export function createWebStorageStore<T>(options: WebStorageOptions<T>) {
  function versionOf(data: unknown) {
    return data && typeof data === "object" && "version" in data ? data.version : undefined;
  }

  return storageEntry<T>(options, (raw) => {
    let data: unknown = JSON.parse(raw);
    if (options.version !== undefined && versionOf(data) !== options.version) {
      data = options.migrate?.(data);
      if (versionOf(data) !== options.version) return null;
    }
    return options.decode(data);
  }, JSON.stringify);
}

export type KeepBlobKeysInput = ReadonlySet<string> | (() => ReadonlySet<string> | null);

interface IdbBlobOptions {
  dbName: string;
  storeName: string;
  version?: number;
  idbFactory?: IDBFactory | null;
}

export function createIdbBlobStore({ dbName, storeName, version = 1, idbFactory }: IdbBlobOptions) {
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    const pending = new Promise<IDBDatabase | null>((resolve) => {
      const factory = idbFactory === undefined ? globalThis.indexedDB : idbFactory;
      if (!factory) return resolve(null);
      const request = factory.open(dbName, version);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        try {
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        } catch {
          request.transaction?.abort();
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        function invalidate() {
          if (dbPromise === pending) dbPromise = null;
        }
        db.onversionchange = () => {
          db.close();
          invalidate();
        };
        db.onclose = invalidate;
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => {
        blocked = true;
        resolve(null);
      };
    }).catch(() => null).then((db) => {
      if (!db && dbPromise === pending) dbPromise = null;
      return db;
    });
    dbPromise = pending;
    return pending;
  }

  async function transact(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void) {
    const db = await openDb();
    if (!db) return false;
    return new Promise<boolean>((resolve) => {
      const tx = db.transaction(storeName, mode);
      tx.oncomplete = () => resolve(true);
      tx.onabort = tx.onerror = () => resolve(false);
      try {
        run(tx.objectStore(storeName));
      } catch {
        tx.abort();
        resolve(false);
      }
    }).catch(() => false);
  }

  async function getBlobs(keys: readonly string[]): Promise<Map<string, Blob>> {
    const blobs = new Map<string, Blob>();
    if (!keys.length) return blobs;
    const success = await transact("readonly", (store) => {
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => {
          const value = request.result;
          if (typeof value?.arrayBuffer === "function") blobs.set(key, value);
        };
      }
    });
    return success ? blobs : new Map();
  }

  async function pruneBlobs(keepKeys: KeepBlobKeysInput, prefix = ""): Promise<void> {
    await transact("readwrite", (store) => {
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        // Other tabs or pending uploads may have added references while opening the DB.
        let keep: ReadonlySet<string> | null;
        try {
          keep = typeof keepKeys === "function" ? keepKeys() : keepKeys;
        } catch {
          // If live references cannot be read, leave all blobs for the next cleanup.
          return;
        }
        if (!keep) return;
        for (const key of keys.result) {
          if (typeof key === "string" && key.startsWith(prefix) && !keep.has(key)) store.delete(key);
        }
      };
    });
  }

  return {
    getBlobs,
    async getBlob(key: string) {
      return (await getBlobs([key])).get(key) ?? null;
    },
    putBlob(key: string, blob: Blob) {
      return transact("readwrite", (store) => store.put(blob, key));
    },
    putBlobs(blobs: ReadonlyMap<string, Blob>) {
      return transact("readwrite", (store) => {
        for (const [key, blob] of blobs) store.put(blob, key);
      });
    },
    async deleteBlob(key: string) {
      await transact("readwrite", (store) => store.delete(key));
    },
    async clearBlobs(prefix?: string) {
      if (prefix) await pruneBlobs(new Set(), prefix);
      else await transact("readwrite", (store) => store.clear());
    },
    pruneBlobs,
  };
}
