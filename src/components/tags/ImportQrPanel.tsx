"use client";

import {useEffect, useState} from "react";
import {Banner} from "@/components/ui/Banner";
import {Button} from "@/components/ui/controls";
import {QrSurface} from "@/components/ui/QrSurface";
import {useSnackbar} from "@/components/ui/Snackbar";

interface ImportSessionResponse {
  token: string;
  qr: string;
  ttlSecs: number;
  issuedAt: number;
}

/**
 * The import ceremony's QR reveal surface (plans/wp4.9-tag-data-custody.md section 2.3) - the
 * counterpart to `ExportQrPanel.tsx`, same auto-start-on-mount/inline-reveal conventions (see that
 * component's own doc comment for why this is not a modal). No status polling: like export, once
 * the code is generated there is nothing further gated on it from the staff side - the completed
 * import becomes visible the ordinary way, by the pet/Tags page reflecting whatever the owner's
 * app actually submitted (a fresh page load or `router.refresh()`, never a live poll this ceremony
 * has no server-side state to usefully poll for beyond "used or not").
 */
export function ImportQrPanel({targetPetId, onClose}: {targetPetId?: string; onClose: () => void}) {
  const snackbar = useSnackbar();
  const [session, setSession] = useState<ImportSessionResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  async function handleStart() {
    setStarting(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/tags/import-sessions", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({targetPetId}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const message = body?.error?.message ?? "Could not create a code.";
        setErrorMessage(message);
        snackbar.show(message, "danger");
        return;
      }
      setSession(body as ImportSessionResponse);
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    handleStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPetId]);

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, [session]);

  const expiresAt = session ? session.issuedAt + session.ttlSecs : undefined;
  const expired = expiresAt !== undefined && now >= expiresAt;

  return (
    <div className="flex flex-col items-center gap-4 rounded-card border border-border bg-surface-2 p-6">
      {starting && !session && <p className="text-body text-ink-faint">Generating a code...</p>}

      {errorMessage && !starting && (
        <Banner tone="danger" title="Could not generate a code">
          <p className="mb-3">{errorMessage}</p>
          <Button onClick={handleStart} disabled={starting}>
            Try again
          </Button>
        </Banner>
      )}

      {session && !expired && (
        <>
          <QrSurface data={session.qr} caption="Scan with the owner's DogTag app" expiresAt={expiresAt} />
          <a
            href={session.qr}
            target="_blank"
            rel="noreferrer"
            data-testid="import-tag-link"
            className="max-w-xs break-all text-center text-caption text-link hover:underline"
          >
            {session.qr}
          </a>
        </>
      )}

      {session && expired && (
        <Banner tone="danger" title="This code expired">
          <p className="mb-3">This code expired before it was scanned. Generate a new one.</p>
          <Button onClick={handleStart} disabled={starting}>
            Generate a new code
          </Button>
        </Banner>
      )}

      <Button variant="ghost" size="sm" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
