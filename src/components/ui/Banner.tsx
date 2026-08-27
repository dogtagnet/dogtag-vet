"use client";

import {useEffect, useState} from "react";
import type {ReactNode} from "react";

export type BannerTone = "info" | "warn" | "danger" | "ok";

const toneClasses: Record<BannerTone, string> = {
  info: "bg-info-soft text-info border-info/30",
  warn: "bg-warn-soft text-warn border-warn/30",
  danger: "bg-danger-soft text-danger border-danger/30",
  ok: "bg-ok-soft text-ok border-ok/30",
};

export interface BannerProps {
  tone: BannerTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  /** Stable key naming the condition this banner reports (e.g. "wallet-not-whitelisted"). When
   * given, dismissal persists per-browser under this key so the banner never nags across visits
   * for the same still-true condition, but reappears if a fresh condition uses a new key. */
  dismissKey?: string;
}

/** Setup prompts and standing-condition warnings (wallet not whitelisted, entity revoked, clone
 * balance low, wrong network) - design-system.md's Banner. Dismiss-persistent per condition, never
 * nagging. */
export function Banner({tone, title, children, action, dismissKey}: BannerProps) {
  const storageKey = dismissKey ? `dogtag-vet:banner-dismissed:${dismissKey}` : undefined;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!storageKey) return;
    try {
      setDismissed(window.localStorage.getItem(storageKey) === "1");
    } catch {
      // localStorage can throw in a locked-down browser context; default to visible.
    }
  }, [storageKey]);

  if (dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, "1");
      } catch {
        // best-effort persistence only
      }
    }
  }

  return (
    <div className={`flex items-start gap-3 rounded-card border px-4 py-3 ${toneClasses[tone]}`} role="status">
      <div className="flex-1">
        <p className="text-body font-medium">{title}</p>
        {children && <div className="mt-1 text-body opacity-90">{children}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
      {dismissKey && (
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-control p-1 text-current opacity-70 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
