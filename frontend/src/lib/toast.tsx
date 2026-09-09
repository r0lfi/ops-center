import { createContext, useCallback, useContext, useEffect, useState } from "react";

import { setApiErrorHandler } from "@/lib/api";

interface ToastItem {
  id: number;
  message: string;
  variant: "error" | "success";
}

interface ToastContextValue {
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

const AUTO_DISMISS_MS: Record<ToastItem["variant"], number> = {
  error: 8000,
  success: 4000,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message: string, variant: ToastItem["variant"]) => {
      const id = ++nextId;
      setToasts((prev) => [...prev, { id, message, variant }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS[variant]);
    },
    [dismiss],
  );

  const showError = useCallback((message: string) => push(message, "error"), [push]);
  const showSuccess = useCallback((message: string) => push(message, "success"), [push]);

  // Wires every failed mutation (see apiSend in lib/api.ts) straight into
  // a toast with no per-call-site plumbing needed.
  useEffect(() => {
    setApiErrorHandler(showError);
    return () => setApiErrorHandler(null);
  }, [showError]);

  return (
    <ToastContext.Provider value={{ showError, showSuccess }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="alert"
            className={
              "pointer-events-auto flex items-start justify-between gap-3 rounded-md border px-4 py-3 text-sm shadow-lg " +
              (t.variant === "error"
                ? "border-status-critical/40 bg-background text-status-critical"
                : "border-status-ok/40 bg-background text-status-ok")
            }
          >
            <span className="break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
