"use client";

import {useState} from "react";
import {truncateMiddle} from "@/lib/format";

export interface MonoValueProps {
  value: string;
  label?: string;
  href?: string;
  prefix?: number;
  suffix?: number;
}

/** Shared rendering for every on-chain identifier: mono font, middle truncation, copy-on-click,
 * optional explorer link and optional label above (design-system.md's AddressChip/HashCell share
 * this exact treatment, differing only in what they link to). */
export function MonoValue({value, label, href, prefix = 6, suffix = 4}: MonoValueProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (permissions, insecure context) - fail silently rather
      // than surface an error for a convenience affordance.
    }
  }

  const display = truncateMiddle(value, prefix, suffix);

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-table-body tabular-nums">
      {label && <span className="text-ink-faint">{label}</span>}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-link hover:underline"
          title={value}
        >
          {display}
        </a>
      ) : (
        <span title={value} className="text-ink">
          {display}
        </span>
      )}
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy to clipboard"
        className="rounded-control text-ink-faint hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      >
        {copied ? (
          <span className="text-caption text-ok">Copied</span>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M3 10.5V3a1 1 0 0 1 1-1h7.5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>
    </span>
  );
}
