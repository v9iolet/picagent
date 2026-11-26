interface ConfigSnapshot<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export function createConfigCache<T>(fetchConfig: () => Promise<T>) {
  let snapshot: ConfigSnapshot<T> = { data: null, loading: false, error: null };
  let pending: Promise<void> | undefined;
  const listeners = new Set<() => void>();

  function publish(next: ConfigSnapshot<T>) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function refresh(saved?: T): Promise<void> {
    // A successful settings mutation returns the current view and supersedes any older GET.
    if (saved !== undefined) {
      pending = undefined;
      publish({ data: saved, loading: false, error: null });
      return Promise.resolve();
    }
    if (pending) return pending;
    const request = Promise.resolve().then(fetchConfig).then(
      (data) => {
        if (pending !== request) return;
        pending = undefined;
        publish({ data, loading: false, error: null });
      },
      (cause) => {
        if (pending !== request) return;
        pending = undefined;
        const error = cause instanceof Error ? cause : new Error("加载配置失败");
        publish({ ...snapshot, loading: false, error });
      },
    );
    pending = request;
    publish({ ...snapshot, loading: true, error: null });
    return request;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load: () => pending ?? (snapshot.data !== null && !snapshot.error ? Promise.resolve() : refresh()),
    refresh,
  };
}
