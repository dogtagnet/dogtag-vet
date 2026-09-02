"use client";

import {useRef, useState} from "react";
import {Banner} from "@/components/ui/Banner";
import {Button, Textarea} from "@/components/ui/controls";
import {StatusBadge, type StatusTone} from "@/components/ui/StatusBadge";
import {MonoValue} from "@/components/ui/MonoValue";

type VerifyStage =
  | {stage: "crypto_failed"}
  | {stage: "malformed_claim"}
  | {stage: "chain_unreadable"}
  | {stage: "not_anchored"; reason: "never_issued" | "root_mismatch"}
  | {stage: "chain_anchored_issuer_unknown"}
  | {stage: "verified"; issuerClone: string; isValid: boolean};

interface VerifyResponse {
  result: VerifyStage;
  disclosedKeyPaths: string[];
  obfuscatedCount: number;
  reservedCount: number;
}

/** Never a guess, never a bare true/false - every stage is a genuinely distinct thing to tell
 * staff (`lib/tags/verifyRedactedFlow.ts`'s own doc comment has the full reasoning for each one). */
function stageDisplay(result: VerifyStage): {tone: StatusTone; label: string; explanation: string} {
  switch (result.stage) {
    case "crypto_failed":
      return {
        tone: "danger",
        label: "Failed",
        explanation: "This document does not hold together cryptographically - it is tampered, corrupted, or violates the protocol (an overlap, a duplicate field, or a malformed reserved set).",
      };
    case "malformed_claim":
      return {
        tone: "danger",
        label: "Failed",
        explanation: "The document's dogTagIdDec and dogTagIdField do not agree with each other.",
      };
    case "chain_unreadable":
      return {
        tone: "warn",
        label: "Chain unreadable",
        explanation: "The document is internally consistent (pure-verified), but the chain could not be reached to confirm it is actually anchored. This is not a failure - try again shortly.",
      };
    case "not_anchored":
      return {
        tone: "warn",
        label: "Pure-verified, not anchored",
        explanation:
          result.reason === "never_issued"
            ? "The document is internally consistent, but this dogTagId has never been issued on chain."
            : "The document is internally consistent, but the chain currently anchors a DIFFERENT root for this dogTagId - this exact document was superseded, or never matched what is actually on chain.",
      };
    case "chain_anchored_issuer_unknown":
      return {
        tone: "warn",
        label: "Chain-anchored, issuer unknown",
        explanation: "Unexpected: the root is anchored on chain, but no issuer is indexed for it. This should not normally occur - treat with caution.",
      };
    case "verified":
      return result.isValid
        ? {
            tone: "ok",
            label: "Verified",
            explanation: "Pure-verified, chain-anchored, and the issuer confirms this tag is currently valid (not revoked).",
          }
        : {
            tone: "warn",
            label: "Anchored, currently invalid",
            explanation: "Pure-verified and chain-anchored with a known issuer, but that issuer reports this tag is currently INVALID (revoked or otherwise invalidated).",
          };
  }
}

/**
 * WP4.10V item 5 - "Verify a redacted artifact" (staff). Paste or upload a `RedactedTagArtifact`
 * JSON document; `POST /api/verify/redacted-artifact` does registry-first shape validation, then
 * the full crypto+chain pipeline, and this panel renders an HONEST result - never a bare
 * true/false (see `stageDisplay` above for every distinct outcome and why it is not collapsed into
 * pass/fail).
 */
export function VerifyRedactedPanel() {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | null>(null);
  const [response, setResponse] = useState<VerifyResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleVerify() {
    setError(null);
    setFieldErrors(null);
    setResponse(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("This is not valid JSON.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/verify/redacted-artifact", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(parsed),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "This does not look like a RedactedTagArtifact.");
        setFieldErrors(body?.error?.details?.fieldErrors ?? null);
        return;
      }
      setResponse(body as VerifyResponse);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const display = response ? stageDisplay(response.result) : null;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h3 className="mb-3 text-section-title text-ink">Document</h3>
        <Textarea
          rows={12}
          className="font-mono text-caption"
          placeholder="Paste a RedactedTagArtifact JSON document here..."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleUpload} className="text-body text-ink-muted" />
          <Button onClick={handleVerify} disabled={submitting || text.trim().length === 0}>
            {submitting ? "Verifying..." : "Verify"}
          </Button>
        </div>

        {error && (
          <Banner tone="danger" title="Could not verify">
            <p>{error}</p>
            {fieldErrors && (
              <ul className="mt-2 list-inside list-disc space-y-1">
                {Object.entries(fieldErrors).map(([field, messages]) => (
                  <li key={field}>
                    <span className="font-mono">{field}</span>: {messages.join("; ")}
                  </li>
                ))}
              </ul>
            )}
          </Banner>
        )}
      </section>

      {response && display && (
        <section className="rounded-card border border-border bg-surface p-5 shadow-card">
          <div className="mb-3 flex items-center gap-3">
            <h3 className="text-section-title text-ink">Result</h3>
            <StatusBadge tone={display.tone} label={display.label} />
          </div>
          <p className="mb-4 text-body text-ink-muted">{display.explanation}</p>

          {response.result.stage === "verified" && (
            <dl className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-caption text-ink-faint">Issuer clone</dt>
                <dd>
                  <MonoValue value={response.result.issuerClone} />
                </dd>
              </div>
            </dl>
          )}

          <div className="border-t border-border pt-4">
            <h4 className="mb-2 text-caption font-medium uppercase tracking-wide text-ink-faint">What this document discloses</h4>
            <ul className="mb-2 space-y-1 text-body text-ink">
              {response.disclosedKeyPaths.length === 0 ? (
                <li className="text-ink-faint">No fields disclosed - every attribute is masked.</li>
              ) : (
                response.disclosedKeyPaths.map((keyPath) => (
                  <li key={keyPath} className="font-mono text-caption">
                    {keyPath}
                  </li>
                ))
              )}
            </ul>
            <p className="text-caption text-ink-faint">
              {response.obfuscatedCount} field{response.obfuscatedCount === 1 ? "" : "s"} masked (named only by hash, not disclosed) -{" "}
              {response.reservedCount} reserved owner-control value{response.reservedCount === 1 ? "" : "s"} (never disclosed by any export).
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
