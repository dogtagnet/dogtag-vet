"use client";

import {useEffect, useRef, useState} from "react";
import {Banner} from "@/components/ui/Banner";
import {Button} from "@/components/ui/controls";
import {FormSection} from "@/components/ui/FormSection";
import {QrSurface} from "@/components/ui/QrSurface";
import {StatusBadge, type StatusTone} from "@/components/ui/StatusBadge";
import {MonoValue} from "@/components/ui/MonoValue";
import {useSnackbar} from "@/components/ui/Snackbar";
import {recordLeafLabel} from "@/lib/records/leafLabels";
import type {RecordVerifySessionStatus, RecordVerifyStoredResult} from "@/lib/models/RecordVerifySession";

interface StartResponse {
  sessionId: string;
  qr: string;
  ttlSecs: number;
  issuedAt: number;
}

interface SessionPoll {
  sessionId: string;
  status: RecordVerifySessionStatus;
  result?: RecordVerifyStoredResult;
  exp: number;
}

/** Never a bare true/false - mirrors `VerifyRedactedPanel.tsx`'s own `stageDisplay` precedent
 * exactly, adapted for `RecordVerifyStoredResult`'s stage union (`lib/records/verifier.ts`'s
 * `RecordVerifyStage`, stored). The plan's own explicit ask - "result shown as Valid/Expired/
 * Revoked" - is the `"verified"` stage's own `validity` sub-classification; every OTHER stage is
 * its own honest, distinct outcome, never collapsed into a false "Invalid" reading. */
function stageDisplay(result: RecordVerifyStoredResult): {tone: StatusTone; label: string; explanation: string} {
  switch (result.stage) {
    case "crypto_failed":
      return {
        tone: "danger",
        label: "Failed",
        explanation: "This document does not hold together cryptographically - it is tampered, corrupted, or violates the protocol.",
      };
    case "chain_unreadable":
      return {
        tone: "warn",
        label: "Chain unreadable",
        explanation: "The document is internally consistent, but the chain could not be reached to confirm it. This is not a failure - ask for a fresh QR and try again shortly.",
      };
    case "wrong_chain":
      return {
        tone: "danger",
        label: "Wrong chain",
        explanation: "This record's disclosed chain id does not match this deployment's own chain - it cannot be checked here.",
      };
    case "not_anchored": {
      const reasonText: Record<string, string> = {
        root_unset: "this root has never been issued on this chain at all.",
        issuer_mismatch: "the chain resolves this root to a DIFFERENT issuing contract than the one this document claims.",
        record_type_mismatch: "the chain disagrees with this document's own claimed record type.",
        operator_mismatch: "the chain disagrees with this document's own claimed issuing operator.",
      };
      return {
        tone: "danger",
        label: "Not anchored",
        explanation: `This document is internally consistent, but ${reasonText[result.reason ?? ""] ?? "it does not match what the chain reports."}`,
      };
    }
    case "verified": {
      if (result.validity === "revoked") {
        return {tone: "danger", label: "Revoked", explanation: "This record was genuinely issued, but the issuing clinic has since revoked it."};
      }
      if (result.validity === "expired") {
        return {tone: "warn", label: "Expired", explanation: "This record is genuine and was never revoked, but its validity window has passed."};
      }
      if (result.validity === "not_yet_valid") {
        return {
          tone: "warn",
          label: "Not yet valid",
          explanation: "This record is genuine and has not been revoked, but its validity window has not opened yet.",
        };
      }
      if (result.validity === "hidden") {
        return {
          tone: "warn",
          label: "Validity hidden",
          explanation:
            "This record is genuine and has not been revoked, but the presenting device did not disclose its validity window, so this deployment cannot say whether it is still in force.",
        };
      }
      return {tone: "ok", label: "Valid", explanation: "This record is genuine, currently valid, and has not been revoked."};
    }
  }
}

/**
 * `/verify/records` - plan section 11.2 V6's "Records mode": staff starts a blind presentment
 * session (no pet/record picked in advance - see `.../start/route.ts`'s own doc comment for why),
 * shows the QR, and polls for the phone's response. The result is the SAME honest, never-a-bare-
 * true/false pattern `VerifyRedactedPanel.tsx` established for the paste-a-document flow, just
 * delivered via a QR/phone round trip instead of a paste box.
 */
export function VerifyRecordsPanel() {
  const snackbar = useSnackbar();
  const [starting, setStarting] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [session, setSession] = useState<SessionPoll | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  function stopTimers() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
  }
  useEffect(() => stopTimers, []);

  async function handleStart() {
    setStarting(true);
    try {
      const res = await fetch("/api/verify/records/start", {method: "POST"});
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        snackbar.show(body?.error?.message ?? "Could not start a verification session", "danger");
        return;
      }
      const started = body as StartResponse;
      setQr(started.qr);
      setSession({sessionId: started.sessionId, status: "pending", exp: started.issuedAt + started.ttlSecs});
      stopTimers();
      pollRef.current = setInterval(async () => {
        const r = await fetch(`/api/verify/records/${started.sessionId}`);
        if (r.ok) setSession(await r.json());
      }, 2000);
      tickRef.current = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    } finally {
      setStarting(false);
    }
  }

  function handleReset() {
    stopTimers();
    setQr(null);
    setSession(null);
  }

  if (qr && session) {
    const expired = session.status === "pending" && now >= session.exp;
    const display = session.result ? stageDisplay(session.result) : null;
    return (
      <div className="max-w-2xl space-y-6">
        <FormSection title="Present a vaccination record" helperText="Status updates automatically.">
          {session.status === "pending" && !expired && (
            <div className="flex justify-center">
              <QrSurface data={qr} caption="Scan with the owner's DogTag app" expiresAt={session.exp} />
            </div>
          )}
          {session.status === "pending" && expired && (
            <Banner tone="danger" title="This code expired">
              <p className="mb-3">No record was presented before this code expired.</p>
              <Button onClick={handleStart} disabled={starting}>
                Generate a new code
              </Button>
            </Banner>
          )}
          {session.status === "presented" && display && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <StatusBadge tone={display.tone} label={display.label} />
                {session.result?.recordType && <MonoValue value={session.result.recordType} label="type" />}
              </div>
              <p className="text-body text-ink-muted">{display.explanation}</p>
              {session.result?.stage === "verified" && session.result.issuerClone && (
                <div>
                  <p className="mb-1 text-caption text-ink-faint">Issuer clone</p>
                  <MonoValue value={session.result.issuerClone} />
                </div>
              )}
              {session.result?.disclosedKeyPaths && session.result.disclosedKeyPaths.length > 0 && (
                <div className="border-t border-border pt-4">
                  <h4 className="mb-2 text-caption font-medium uppercase tracking-wide text-ink-faint">What was disclosed</h4>
                  <ul className="space-y-1 text-body text-ink">
                    {session.result.disclosedKeyPaths.map((keyPath) => (
                      <li key={keyPath}>{recordLeafLabel(keyPath)}</li>
                    ))}
                  </ul>
                  {typeof session.result.hiddenCount === "number" && (
                    // Plan section 11.2 V6's own explicit ask - the same singular/plural idiom
                    // VerifyRedactedPanel.tsx's own "N field(s) masked" caption already uses.
                    <p className="mt-2 text-caption text-ink-faint">
                      {session.result.hiddenCount} field{session.result.hiddenCount === 1 ? "" : "s"} hidden (masked by the presenting device, not disclosed).
                    </p>
                  )}
                </div>
              )}
              <div>
                <Button variant="secondary" onClick={handleReset}>
                  Verify another
                </Button>
              </div>
            </div>
          )}
        </FormSection>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <FormSection
        title="Present a vaccination record"
        helperText="No pet is picked in advance - any dogtag app can scan this and choose which of its own vaccination records to present."
      >
        <p className="text-body text-ink-muted">
          Generates a one-time QR (valid 10 minutes). Once scanned, the presenting device chooses which record to send; this deployment
          independently re-checks it against the chain before showing a result.
        </p>
      </FormSection>
      <div className="flex justify-end">
        <Button onClick={handleStart} disabled={starting}>
          {starting ? "Starting..." : "Start records verification"}
        </Button>
      </div>
    </div>
  );
}
