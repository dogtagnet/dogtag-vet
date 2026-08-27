"use client";

import {useEffect, useState} from "react";
import QRCode from "qrcode";
import {formatCountdown} from "@/lib/format";

export interface QrSurfaceProps {
  data: string;
  caption?: string;
  /** Unix seconds this code stops being valid - renders a live countdown beneath the code. */
  expiresAt?: number;
  size?: number;
}

/** QR surfaces always print on a white quiet zone, even in dark theme, and carry an expiry
 * countdown for one-time tokens - design-system.md. The quiet zone uses the fixed `--qr-paper`
 * token (white in both themes) rather than `--surface`, which flips dark in dark mode. */
export function QrSurface({data, caption, expiresAt, size = 220}: QrSurfaceProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(data, {margin: 2, width: size, color: {dark: "#16202B", light: "#FFFFFF"}})
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [data, size]);

  useEffect(() => {
    if (expiresAt === undefined) return;
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const remaining = expiresAt !== undefined ? expiresAt - now : undefined;
  const expired = remaining !== undefined && remaining <= 0;

  return (
    <div className="inline-flex flex-col items-center gap-2">
      <div
        className="rounded-card p-4"
        style={{backgroundColor: "var(--qr-paper)", width: size + 32, height: size + 32}}
      >
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data: URL, not an optimizable remote image
          <img src={dataUrl} alt="QR code" width={size} height={size} />
        ) : (
          <div style={{width: size, height: size}} className="animate-pulse bg-surface-2" />
        )}
      </div>
      {caption && <p className="text-caption text-ink-muted">{caption}</p>}
      {remaining !== undefined && (
        <p className={`text-caption ${expired ? "text-danger" : "text-ink-faint"}`}>
          {expired ? "Expired" : `Expires in ${formatCountdown(remaining)}`}
        </p>
      )}
    </div>
  );
}
