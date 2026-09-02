"use client";

import {useEffect, useState} from "react";
import {Banner} from "@/components/ui/Banner";
import {Button} from "@/components/ui/controls";
import {MonoValue} from "@/components/ui/MonoValue";
import {QrSurface} from "@/components/ui/QrSurface";
import {useSnackbar} from "@/components/ui/Snackbar";

interface ExportableFieldWire {
  keyPath: string;
  tag: number;
  value: string;
  leafHash: string;
  group: "pet" | "owner_identity";
}

interface FieldsResponse {
  fields: ExportableFieldWire[];
  reservedCount: number;
}

interface ExportSessionResponse {
  token: string;
  qr: string;
  ttlSecs: number;
  issuedAt: number;
}

type ActionKind = "download" | "qr" | "copy";

/**
 * WP4.10V item 4 - "Export with masking": a field picker over the pet's ACTIVE artifact's own
 * disclosed leaves, grouped ("Pet attributes" / "Owner identity" - WP4.10S ruled the non-maskable
 * set EMPTY, so BOTH groups are equally maskable, including owner identity), a live preview of the
 * masked document, and three actions (Download JSON | Show QR | Copy JSON) that all produce the
 * exact SAME `RedactedTagArtifact`-shaped payload for the currently-checked mask.
 *
 * NEVER imports `@dogtag/standard` - this is a "use client" component, and this repo's own
 * `next.config.ts` externalizes the poseidon/circomlibjs dependency chain for exactly this reason
 * (`e2e/tag-custody.spec.ts`'s own doc comment names the precedent cold-client-build incident).
 * Every leaf hash shown here (`ExportableFieldWire.leafHash`) is PRECOMPUTED server-side
 * (`GET .../export-tag-data/fields`) - the live preview below is a pure client-side value-to-hash
 * swap, no crypto in the browser. The three actions below likewise never compute a hash client-side:
 * "Show QR" mints a session and lets the SERVER's own `/e/:token` do the real work; "Download
 * JSON"/"Copy JSON" call the staff-only `.../export-tag-data/preview` route, which builds and
 * self-checks the same payload server-side and returns it directly (see that route's own doc
 * comment for why it is not simply "mint a session, then fetch its /e/:token URL" - a same-page
 * cross-origin fetch to the phone-facing `PUBLIC_BASE_URL` would risk CORS silently burning the
 * one-time token without ever delivering the file).
 */
export function MaskedExportPanel({petId, onClose}: {petId: string; onClose: () => void}) {
  const snackbar = useSnackbar();
  const [fields, setFields] = useState<FieldsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [masked, setMasked] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState<ActionKind | null>(null);
  const [qrSession, setQrSession] = useState<ExportSessionResponse | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pets/${petId}/export-tag-data/fields`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(body?.error?.message ?? "Could not load this pet's tag data.");
          return;
        }
        setFields(body as FieldsResponse);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load this pet's tag data.");
      });
    return () => {
      cancelled = true;
    };
  }, [petId]);

  useEffect(() => {
    if (!qrSession) return;
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, [qrSession]);

  function toggle(keyPath: string) {
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
      const session = await postJson<ExportSessionResponse>(`/api/pets/${petId}/export-tag-data`);
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
      const preview = await postJson<Record<string, unknown>>(`/api/pets/${petId}/export-tag-data/preview`);
      if (!preview) return;
      const text = JSON.stringify(preview, null, 2);
      const blob = new Blob([text], {type: "application/json"});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dogtag-${petId}${masked.size > 0 ? "-masked" : ""}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      snackbar.show("Downloaded", "ok");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCopy() {
    setBusyAction("copy");
    try {
      const preview = await postJson<Record<string, unknown>>(`/api/pets/${petId}/export-tag-data/preview`);
      if (!preview) return;
      await navigator.clipboard.writeText(JSON.stringify(preview, null, 2));
      snackbar.show("Copied", "ok");
    } catch {
      snackbar.show("Could not copy - try Download instead.", "danger");
    } finally {
      setBusyAction(null);
    }
  }

  const petFields = fields?.fields.filter((f) => f.group === "pet") ?? [];
  const ownerIdentityFields = fields?.fields.filter((f) => f.group === "owner_identity") ?? [];
  const expiresAt = qrSession ? qrSession.issuedAt + qrSession.ttlSecs : undefined;
  const qrExpired = expiresAt !== undefined && now >= expiresAt;

  return (
    <div className="flex flex-col gap-4 rounded-card border border-border bg-surface-2 p-6">
      {!fields && !loadError && <p className="text-body text-ink-faint">Loading this pet&apos;s tag data...</p>}

      {loadError && (
        <Banner tone="danger" title="Could not load tag data">
          <p>{loadError}</p>
        </Banner>
      )}

      {fields && (
        <>
          <div>
            <h4 className="mb-1 text-section-title text-ink">Choose fields to mask</h4>
            <p className="text-caption text-ink-faint">
              A masked field is never disclosed - only its cryptographic hash travels with the export. The root still recomputes and still
              verifies; nothing about masking a field can be detected as tampering.
            </p>
          </div>

          <FieldGroup title="Pet attributes" fieldsList={petFields} masked={masked} onToggle={toggle} />
          {ownerIdentityFields.length > 0 && (
            <FieldGroup title="Owner identity" fieldsList={ownerIdentityFields} masked={masked} onToggle={toggle} />
          )}

          <p className="text-caption text-ink-faint">
            {fields.reservedCount} reserved owner-control value{fields.reservedCount === 1 ? "" : "s"} - always hidden, never shared, and
            never a choice: these stay opaque hashes in every export, masked or not.
          </p>

          <div>
            <h4 className="mb-2 text-section-title text-ink">Live preview</h4>
            <dl className="space-y-1.5 rounded-control border border-border bg-surface p-3">
              {fields.fields.map((f) => (
                <div key={f.keyPath} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <dt className="font-mono text-caption text-ink-faint">{f.keyPath}</dt>
                  <dd className="text-body text-ink">
                    {masked.has(f.keyPath) ? <MonoValue value={f.leafHash} label="masked" prefix={6} suffix={4} /> : f.value}
                  </dd>
                </div>
              ))}
              {fields.fields.length === 0 && <p className="text-caption text-ink-faint">No attribute leaves on this artifact.</p>}
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
                data-testid="masked-export-link"
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

function FieldGroup({
  title,
  fieldsList,
  masked,
  onToggle,
}: {
  title: string;
  fieldsList: ExportableFieldWire[];
  masked: Set<string>;
  onToggle: (keyPath: string) => void;
}) {
  if (fieldsList.length === 0) return null;
  return (
    <div>
      <h5 className="mb-1.5 text-caption font-medium uppercase tracking-wide text-ink-faint">{title}</h5>
      <ul className="space-y-1.5">
        {fieldsList.map((f) => (
          <li key={f.keyPath}>
            <label className="flex items-center gap-2 text-body text-ink">
              <input type="checkbox" checked={masked.has(f.keyPath)} onChange={() => onToggle(f.keyPath)} />
              <span className="font-mono text-caption text-ink-faint">{f.keyPath}</span>
              <span className="text-ink-muted">{f.value}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
