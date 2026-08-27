"use client";

import {createContext, useCallback, useContext, useMemo, useState} from "react";
import type {ReactNode} from "react";

export type SnackbarTone = "ok" | "danger" | "info";

interface SnackbarMessage {
  id: string;
  tone: SnackbarTone;
  text: string;
}

interface SnackbarContextValue {
  show: (text: string, tone?: SnackbarTone) => void;
}

const SnackbarContext = createContext<SnackbarContextValue | null>(null);

const toneClasses: Record<SnackbarTone, string> = {
  ok: "bg-ok text-white",
  danger: "bg-danger text-white",
  info: "bg-info text-white",
};

/** Transient-result surface (design-system.md's Snackbar): "payment marked paid", "tag revoked",
 * and similar one-line confirmations. Mount SnackbarProvider once near the app root; call
 * `useSnackbar().show(...)` from anywhere beneath it. */
export function SnackbarProvider({children}: {children: ReactNode}) {
  const [messages, setMessages] = useState<SnackbarMessage[]>([]);

  const show = useCallback((text: string, tone: SnackbarTone = "info") => {
    const id = Math.random().toString(36).slice(2);
    setMessages((prev) => [...prev, {id, tone, text}]);
    setTimeout(() => {
      setMessages((prev) => prev.filter((m) => m.id !== id));
    }, 4000);
  }, []);

  const value = useMemo(() => ({show}), [show]);

  return (
    <SnackbarContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {messages.map((m) => (
          <div
            key={m.id}
            role="status"
            className={`pointer-events-auto rounded-control px-4 py-2.5 text-body shadow-raised ${toneClasses[m.tone]}`}
          >
            {m.text}
          </div>
        ))}
      </div>
    </SnackbarContext.Provider>
  );
}

export function useSnackbar(): SnackbarContextValue {
  const ctx = useContext(SnackbarContext);
  if (!ctx) throw new Error("useSnackbar must be used within a SnackbarProvider");
  return ctx;
}
