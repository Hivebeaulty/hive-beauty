"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastTone = "success" | "error" | "info";
type Toast = { id: number; tone: ToastTone; message: string };

const ToastContext = createContext<{ push: (tone: ToastTone, message: string) => void } | null>(
  null
);

const TONE_ICON: Record<ToastTone, React.ElementType> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

const TONE_ICON_CLASS: Record<ToastTone, string> = {
  success: "text-success",
  error: "text-danger",
  info: "text-ink-500",
};

let idCounter = 0;

// Provider montado uma vez em app/layout.tsx. Telas chamam useToast() e
// não precisam mais renderizar <p className="text-danger"> manualmente.
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = ++idCounter;
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] z-50 flex flex-col gap-2 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-80"
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map((t) => {
          const Icon = TONE_ICON[t.tone];
          return (
            <div
              key={t.id}
              className="flex animate-slide-in-right items-start gap-2.5 rounded-lg border border-ink-100 bg-surface p-3.5 shadow-elevated"
            >
              <Icon className={cn("mt-0.5 size-4.5 shrink-0", TONE_ICON_CLASS[t.tone])} />
              <p className="flex-1 text-sm text-ink-800">{t.message}</p>
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Fechar aviso"
                className="text-ink-300 hover:text-ink-600"
              >
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() precisa estar dentro de <ToastProvider>.");
  return {
    success: (message: string) => ctx.push("success", message),
    error: (message: string) => ctx.push("error", message),
    info: (message: string) => ctx.push("info", message),
  };
}
