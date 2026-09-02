"use client";

import {useEffect, useState} from "react";
import {Banner} from "@/components/ui/Banner";
import {Button} from "@/components/ui/controls";
import {QrSurface} from "@/components/ui/QrSurface";
import {useSnackbar} from "@/components/ui/Snackbar";

interface ExportSessionResponse {
  token: string;
  qr: string;
  ttlSecs: number;
  issuedAt: number;
}

/**
 * The export ceremony's QR reveal surface (plans/wp4.9-tag-data-custody.md section 2.2) - shared by
 * `TagsTable.tsx`'s per-row `renderExpansion` band and the pet page's `ShareTagDataAction.tsx`, the
 * same "one small reusable panel, two mount points" split `ReceiptPanel`/`WalletsPanel.tsx` already
 * uses. This app has no dialog/modal primitive anywhere (`WalletsPanel.tsx`'s own doc comment:
 * "design-system.md has no native-dialog convention") - this reads the checklist's "modal QR" as
 * "a QR reveal surface", the same inline-reveal idiom every other ceremony in this app already
 * uses, not a new overlay component for one feature.
 *
 * Auto-starts on mount (no second click inside the panel) - the CALLER's own trigger (expanding a
 * table row, or this component's own sibling button on the pet page) is already the user's
 * deliberate action; requiring a second click here would be redundant, unlike WalletsPanel's
 * "Register wallet" button, which is the FIRST and only click for that ceremony.
 */
export function ExportQrPanel({petId, onClose}: {petId: string; onClose: () => void}) {
  const snackbar = useSnackbar();
  const [session, setSession] = useState<ExportSessionResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  async function handleStart() {
    setStarting(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/pets/${petId}/export-tag-data`, {method: "POST"});
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const message = body?.error?.message ?? "Could not create a share code.";
        setErrorMessage(message);
        snackbar.show(message, "danger");
        return;
      }
      setSession(body as ExportSessionResponse);
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    handleStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [petId]);

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, [session]);

  const expiresAt = session ? session.issuedAt + session.ttlSecs : undefined;
  const expired = expiresAt !== undefined && now >= expiresAt;

  return (
    <div className="flex flex-col items-center gap-4 rounded-card border border-border bg-surface-2 p-6">
      {starting && !session && <p className="text-body text-ink-faint">Generating a share code...</p>}

      {errorMessage && !starting && (
        <Banner tone="danger" title="Could not generate a share code">
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
            data-testid="export-tag-data-link"
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
