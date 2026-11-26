export function createFakeAsyncIndexedDb(openGate: Promise<void>) {
  const stores = new Map<string, Map<string, unknown>>();
  let openCount = 0;

  const factory = {
    open(_name: string, _version?: number) {
      openCount += 1;
      const req: {
        result?: unknown;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
      } = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };

      const db = {
        objectStoreNames: {
          contains: (name: string) => stores.has(name),
        },
        createObjectStore: (name: string) => {
          if (!stores.has(name)) stores.set(name, new Map());
          return {};
        },
        onversionchange: null as (() => void) | null,
        onclose: null as (() => void) | null,
        close: () => {},
        transaction: (storeName: string, _mode: IDBTransactionMode) => {
          const map = stores.get(storeName);
          if (!map) throw new Error(`Missing object store ${storeName}`);
          const tx: {
            oncomplete: (() => void) | null;
            onerror: (() => void) | null;
            onabort: (() => void) | null;
            objectStore: (name: string) => unknown;
          } = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore: () => ({
              put: (value: unknown, key: string) => {
                map.set(key, value);
                const r: { onsuccess: (() => void) | null; onerror: (() => void) | null } = {
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => r.onsuccess?.());
                return r;
              },
              get: (key: string) => {
                const r: {
                  result: unknown;
                  onsuccess: (() => void) | null;
                  onerror: (() => void) | null;
                } = {
                  result: map.get(key),
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => r.onsuccess?.());
                return r;
              },
              getAllKeys: () => {
                const r: {
                  result: string[];
                  onsuccess: (() => void) | null;
                  onerror: (() => void) | null;
                } = {
                  result: Array.from(map.keys()),
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask(() => r.onsuccess?.());
                return r;
              },
              delete: (key: string) => {
                map.delete(key);
                return {};
              },
              clear: () => {
                map.clear();
                return {};
              },
            }),
          };
          // Complete transaction after request microtasks finish (matching IDB transaction semantics).
          queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
          return tx;
        },
      };

      void openGate.then(() => {
        req.result = db;
        if (!stores.size) {
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });

      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  return {
    factory,
    getStore: (name = "blobs") => stores.get(name),
    getOpenCount: () => openCount,
  };
}
