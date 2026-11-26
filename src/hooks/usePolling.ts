import { useEffect, useEffectEvent, type DependencyList } from "react";

type Poll = (signal: AbortSignal) => Promise<void> | void;
interface PollingOptions {
  enabled: boolean;
  intervalMs: number;
  initialDelayMs?: number;
  pauseWhenHidden?: boolean;
  onError?: (error: unknown) => void;
}

export function startPolling(
  poll: Poll,
  { enabled, intervalMs, initialDelayMs = intervalMs, pauseWhenHidden = true, onError }: PollingOptions,
  visibility: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document,
) {
  if (!enabled) return;
  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;

  async function tick(signal: AbortSignal) {
    try {
      await poll(signal);
    } catch (error) {
      if (!signal.aborted) onError?.(error);
    } finally {
      if (!signal.aborted) timer = setTimeout(() => void tick(signal), intervalMs);
    }
  }

  function cancel() {
    clearTimeout(timer);
    controller.abort();
  }

  function onVisibilityChange() {
    cancel();
    if (!visibility.hidden) {
      controller = new AbortController();
      void tick(controller.signal);
    }
  }

  if (pauseWhenHidden) visibility.addEventListener("visibilitychange", onVisibilityChange);
  if (!pauseWhenHidden || !visibility.hidden) {
    if (initialDelayMs === 0) void tick(controller.signal);
    else timer = setTimeout(() => void tick(controller.signal), initialDelayMs);
  }
  return () => {
    cancel();
    if (pauseWhenHidden) visibility.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

// Dependencies identify the resource being polled. UI callbacks can change without restarting its timer.
export function usePolling(poll: Poll, options: PollingOptions, dependencies: DependencyList = []) {
  const tick = useEffectEvent(poll);
  const onError = useEffectEvent((error: unknown) => options.onError?.(error));
  const { enabled, intervalMs, initialDelayMs, pauseWhenHidden } = options;
  useEffect(() => startPolling(tick, { enabled, intervalMs, initialDelayMs, pauseWhenHidden, onError }),
    [enabled, intervalMs, initialDelayMs, pauseWhenHidden, ...dependencies]);
}
