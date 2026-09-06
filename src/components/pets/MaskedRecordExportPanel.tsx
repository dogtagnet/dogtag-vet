"use client";

import {useEffect, useState} from "react";
import {Banner} from "@/components/ui/Banner";
import {Button} from "@/components/ui/controls";
import {MonoValue} from "@/components/ui/MonoValue";
import {QrSurface} from "@/components/ui/QrSurface";
import {useSnackbar} from "@/components/ui/Snackbar";
import {recordLeafLabel} from "@/lib/records/leafLabels";

interface ExportableRecordFieldWire {
  keyPath: string;
  tag: number;
  value: string;
  leafHash: string;
  locked: boolean;
}

interface FieldsResponse {
  fields: ExportableRecordFieldWire[];
}

interface ExportSessionResponse {
  token: string;
  qr: string;
  ttlSecs: number;
  issuedAt: number;
}

type ActionKind = "download" | "qr" | "copy";

/**
 * Plan section 11.2 V5 - "Export to the phone" for a vaccination record, reusing the WP4.10V export
 * UI pattern (`MaskedExportPanel.tsx`) exactly: a field picker over the record's own disclosed
 * leaves, a live preview, and three actions (Download JSON | Show QR | Copy JSON) all producing the
 * SAME `RecordArtifact`-shaped payload for the currently-checked mask.
 *
 * THE ONE REAL DIFFERENCE FROM THE TAG PANEL: a record HAS a non-maskable set (seven keyPaths,
 * `ExportableRecordFieldWire.locked`) - locked fields render as an unchecked, disabled checkbox
 * (never maskable, never a choice) rather than the tag panel's "everything is equally maskable, just
 * grouped for display" model. This is the export UI's own half of the plan's non-negotiable ("the
 * non-maskable set ... is locked in the export UI AND enforced server-side" - the server-side half
 * is `lib/records/exportMask.ts`'s `validateRecordExportMask`, which would refuse a locked keyPath
 * even if this UI somehow let one through).
 *
 * NEVER imports `@dogtag/standard` - same cold-client-build reason `MaskedExportPanel.tsx`'s own
 * header names; every leaf hash here is precomputed server-side (`GET .../export/fields`).
 */
export function MaskedRecordExportPanel({petId, recordId, onClose}: {petId: string; recordId: string; onClose: () => void}) {
  const snackbar = useSnackbar();
  const [fields, setFields] = useState<FieldsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [masked, setMasked] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState<ActionKind | null>(null);
  const [qrSession, setQrSession] = useState<ExportSessionResponse | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pets/${petId}/records/${recordId}/export/fields`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(body?.error?.message ?? "Could not load this record's data.");
          return;
        }
        setFields(body as FieldsResponse);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load this record's data.");
      });
    return () => {
      cancelled = true;
    };
  }, [petId, recordId]);

  useEffect(() => {
    if (!qrSession) return;
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, [qrSession]);

  function toggle(keyPath: string, locked: boolean) {
    if (locked) return;
    setMasked((prev) => {
      const next = new Set(prev);
      if (next.has(keyPath)) next.delete(keyPath);
      else next.add(keyPath);
      return next;
    });
  }

  async function postJson<T>(path: string): Promise<T | null> {
    const res = await fetch(path, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({mask: Array.from(masked)}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      snackbar.show(body?.error?.message ?? "Something went wrong.", "danger");
      return null;
    }
    return body as T;
  }

  async function handleShowQr() {
    setBusyAction("qr");
    try {
      const session = await postJson<ExportSessionResponse>(`/api/pets/${petId}/records/${recordId}/export`);
      if (session) {
        setQrSession(session);
        setNow(Math.floor(Date.now() / 1000));
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDownload() {
    setBusyAction("download");
    try {
      const preview = await postJson<Record<string, unknown>>(`/api/pets/${petId}/records/${recordId}/export/preview`);
      if (!preview) return;
      const text = JSON.stringify(preview, null, 2);
      const blob = new Blob([text], {type: "application/json"});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dogtag-record-${recordId}${masked.size > 0 ? "-masked" : ""}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      snackbar.show("Downloaded", "ok");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCopy() {
    setBusyAction("copy");
    try {
      const preview = await postJson<Record<string, unknown>>(`/api/pets/${petId}/records/${recordId}/export/preview`);
      if (!preview) return;
      await navigator.clipboard.writeText(JSON.stringify(preview, null, 2));
      snackbar.show("Copied", "ok");
    } catch {
      snackbar.show("Could not copy - try Download instead.", "danger");
    } finally {
      setBusyAction(null);
    }
  }

  const lockedFields = fields?.fields.filter((f) => f.locked) ?? [];
  const maskableFields = fields?.fields.filter((f) => !f.locked) ?? [];
  const expiresAt = qrSession ? qrSession.issuedAt + qrSession.ttlSecs : undefined;
  const qrExpired = expiresAt !== undefined && now >= expiresAt;

  return (
    <div className="flex flex-col gap-4 rounded-card border border-border bg-surface-2 p-6">
      {!fields && !loadError && <p className="text-body text-ink-faint">Loading this record&apos;s data...</p>}

      {loadError && (
        <Banner tone="danger" title="Could not load record data">
          <p>{loadError}</p>
        </Banner>
      )}

      {fields && (
        <>
          <div>
            <h4 className="mb-1 text-section-title text-ink">Choose fields to mask</h4>
            <p className="text-caption text-ink-faint">
              A masked field is never disclosed - only its cryptographic hash travels with the export. Locked fields cannot be masked at
              all (they identify the pet, the credential type, and the issuer - a reader must always be able to check those).
            </p>
          </div>

          {lockedFields.length > 0 && (
            <div>
              <h5 className="mb-1.5 text-caption font-medium uppercase tracking-wide text-ink-faint">Always disclosed (locked)</h5>
              <ul className="space-y-1.5">
                {lockedFields.map((f) => (
                  <li key={f.keyPath}>
                    <label className="flex items-center gap-2 text-body text-ink opacity-70">
                      <input type="checkbox" checked disabled />
                      <span className="text-ink-muted">{recordLeafLabel(f.keyPath)}</span>
                      <span className="text-ink-faint">{f.value}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {maskableFields.length > 0 && (
            <div>
              <h5 className="mb-1.5 text-caption font-medium uppercase tracking-wide text-ink-faint">Maskable</h5>
              <ul className="space-y-1.5">
                {maskableFields.map((f) => (
                  <li key={f.keyPath}>
                    <label className="flex items-center gap-2 text-body text-ink">
                      <input type="checkbox" checked={masked.has(f.keyPath)} onChange={() => toggle(f.keyPath, f.locked)} />
                      <span className="text-ink-muted">{recordLeafLabel(f.keyPath)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h4 className="mb-2 text-section-title text-ink">Live preview</h4>
            <dl className="space-y-1.5 rounded-control border border-border bg-surface p-3">
              {fields.fields.map((f) => (
                <div key={f.keyPath} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <dt className="text-caption text-ink-faint">{recordLeafLabel(f.keyPath)}</dt>
                  <dd className="text-body text-ink">
                    {masked.has(f.keyPath) ? <MonoValue value={f.leafHash} label="masked" prefix={6} suffix={4} /> : f.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {!qrSession && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" onClick={handleDownload} disabled={busyAction !== null}>
                {busyAction === "download" ? "Preparing..." : "Download JSON"}
              </Button>
              <Button variant="secondary" onClick={handleShowQr} disabled={busyAction !== null}>
                {busyAction === "qr" ? "Generating..." : "Show QR"}
              </Button>
              <Button variant="secondary" onClick={handleCopy} disabled={busyAction !== null}>
                {busyAction === "copy" ? "Copying..." : "Copy JSON"}
              </Button>
            </div>
          )}

          {qrSession && !qrExpired && (
            <div className="flex flex-col items-center gap-3 border-t border-border pt-4">
              <QrSurface data={qrSession.qr} caption="Scan with the owner's DogTag app" expiresAt={expiresAt} />
              <a
                href={qrSession.qr}
                target="_blank"
                rel="noreferrer"
                data-testid="masked-record-export-link"
                className="max-w-xs break-all text-center text-caption text-link hover:underline"
              >
                {qrSession.qr}
              </a>
              <Button variant="ghost" size="sm" onClick={() => setQrSession(null)}>
                Back to field picker
              </Button>
            </div>
          )}

          {qrSession && qrExpired && (
            <Banner tone="danger" title="This code expired">
              <p className="mb-3">This code expired before it was scanned. Generate a new one.</p>
              <Button onClick={handleShowQr} disabled={busyAction !== null}>
                Generate a new code
              </Button>
            </Banner>
          )}
        </>
      )}

      <div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
