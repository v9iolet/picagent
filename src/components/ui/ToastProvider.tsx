import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ModelSettingsMessage } from "../../pages/shared";
import "./Toast.css";

type ToastOptions = { durationMs?: number | null; tone?: "info" | "success" | "error" };
type Toast = { message: string; durationMs: number | null; tone: NonNullable<ToastOptions["tone"]> };
const ToastContext = createContext<{
  showToast: (message: string, options?: ToastOptions) => void;
  dismissToast: () => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const showToast = useCallback((message: string, { durationMs = 2400, tone = "info" }: ToastOptions = {}) => {
    setToast({ message, tone, durationMs: message.includes("配置 → 偏好设置") ? null : durationMs });
  }, []);
  const actions = useMemo(() => ({ showToast, dismissToast }), [showToast, dismissToast]);

  useEffect(() => {
    if (!toast || toast.durationMs === null) return;
    const timer = setTimeout(() => setToast(current => current === toast ? null : current), toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext.Provider value={actions}>
      {children}
      {toast && <div role="status" className="suite-toast show" data-tone={toast.tone}>
        <ModelSettingsMessage message={toast.message} />
      </div>}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const actions = useContext(ToastContext);
  if (!actions) throw new Error("useToast requires ToastProvider");
  return actions;
}
