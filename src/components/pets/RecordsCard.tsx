"use client";

import {useEffect, useState} from "react";
import {useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {DataTable} from "@/components/ui/DataTable";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {HashCell} from "@/components/ui/HashCell";
import {Banner} from "@/components/ui/Banner";
import {Button, Select} from "@/components/ui/controls";
import {useSnackbar} from "@/components/ui/Snackbar";
import {IssueRecordForm} from "@/components/pets/IssueRecordForm";
import {RecordDetailPanel} from "@/components/pets/RecordDetailPanel";
import {MaskedRecordExportPanel} from "@/components/pets/MaskedRecordExportPanel";
import {vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTxWithGas} from "@/lib/chainWrite";
import {REASON_CODES, reasonCodeHash, type ReasonCodeName} from "@/lib/reasonCodes";
import {decodeRefundOutcome, refundFeedbackMessage} from "@/lib/refundFeedback";
import {recordStatusLabel, recordStatusTone, recordValidityLabel, recordValidityTone} from "@/lib/recordStatusTone";
import {computeRecordValidity, formatIsoCalendarDate} from "@/lib/records/validity";
import {formatUnixSeconds} from "@/lib/format";
import type {RecordArtifactDoc} from "@/lib/models/RecordArtifact";

function leafValue(record: RecordArtifactDoc, keyPath: string): string {
  return record.leaves.find((l) => l.keyPath === keyPath)?.value ?? "-";
}

/** Triggers a browser download of the record's stored C3 issuer attestation as a JSON file (plan
 * section 11.2 V4's "attestation download") - the attestation is already present on the record this
 * card already fetched, so this is a pure client-side `Blob` + object URL, no extra round trip. */
function downloadAttestation(record: RecordArtifactDoc) {
  if (!record.attestation) return;
  const blob = new Blob([JSON.stringify(record.attestation, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dogtag-record-attestation-${record.recordId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred, not synchronous: revoking the object URL immediately after `click()` can cancel the
  // download in some browsers, which only start reading the blob on the next tick.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The pet page's Records tab (plan section 11.2 V4) - list of every `RecordArtifact` for this pet,
 * newest first (`GET /api/pets/:id/records`, `RecordArtifact.ts`'s own `{petId, createdAt: -1}`
 * index), with an inline "Issue vaccination record" wizard, a per-row detail expansion (dynamic
 * key/value leaf renderer), revoke (owner/vet + reason -> `clone.revokeRecord` + confirm, mirroring
 * `TagsTable.tsx`'s own revoke idiom), and attestation download for an active, already-attested row.
 */
export function RecordsCard({petId, timeZone, dogTagIssued}: {petId: string; timeZone: string; dogTagIssued: boolean}) {
  const {address, chainId} = useAccount();
  const {writeContractAsync} = useWriteContract();
  const publicClient = usePublicClient();
  const snackbar = useSnackbar();

  const [records, setRecords] = useState<RecordArtifactDoc[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  // At most one row's expansion open at a time, and at most one KIND per row - mirrors
  // `TagsTable.tsx`'s own `expandedExport` idiom (a `DataTable` row has exactly one expansion slot).
  const [expanded, setExpanded] = useState<{recordId: string; kind: "details" | "export"} | null>(null);
  const [reasonByRecord, setReasonByRecord] = useState<Record<string, ReasonCodeName>>({});
  const [busyRecordId, setBusyRecordId] = useState<string | null>(null);
  const [retryingRecordId, setRetryingRecordId] = useState<string | null>(null);
  const [pendingTx, setPendingTx] = useState<{hash: `0x${string}`; recordId: string; cloneAddress: string; reasonCode: ReasonCodeName} | null>(null);
  // WP4.19 V5 - the reverted-receipt gap `TagsTable.tsx`/`TagIssueWizard.tsx` were fixed for
  // (2026-09-25 incident, round 2) also applies here: `useWaitForTransactionReceipt` never resolves
  // `isSuccess` for a REVERTED receipt (it throws internally and surfaces as `isError` instead), so
  // gating this card's confirm effect on `isSuccess` alone left a reverted `revokeRecord` stuck on
  // "Revoke" being disabled with no feedback forever - reproduced directly before this fix (a
  // scripted status:"reverted" receipt left `busyRecordId` cleared but no banner/snackbar ever
  // fired). Kept for the record, like `TagIssueWizard`'s own `lastFailedTxHash` - shown next to the
  // row's Revoke button so staff can retry without losing which tx failed.
  const [failedRevoke, setFailedRevoke] = useState<{recordId: string; hash: string; message: string} | null>(null);

  const receipt = useWaitForTransactionReceipt({hash: pendingTx?.hash, chainId: roax.id});

  async function load() {
    const res = await fetch(`/api/pets/${petId}/records`);
    if (res.ok) setRecords((await res.json()).records);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [petId]);

  useEffect(() => {
    // `isError` too, not just `isSuccess` (WP4.19 V5, replicating the 2026-09-25 incident fix round
    // 2 - see `failedRevoke`'s own doc comment above for the full reasoning, identical to
    // `TagsTable.tsx`'s `revokeTag`/`reactivateTag` effect). `/lifecycle` already re-reads
    // `isValid(root)` on chain before trusting either outcome (that route's own doc comment), so
    // calling it on `isError` is exactly as safe as calling it on `isSuccess` already was.
    if ((receipt.isSuccess || receipt.isError) && pendingTx) {
      fetch(`/api/records/${pendingTx.recordId}/lifecycle`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({reasonCode: pendingTx.reasonCode, txHash: pendingTx.hash}),
      })
        .then(async (r) => ({ok: r.ok, body: await r.json().catch(() => null)}))
        .then(({ok, body}) => {
          if (ok) {
            setFailedRevoke(null);
            // WP4.19 V2 - only on an actually-successful receipt (see TagIssueWizard.tsx's
            // identical comment on why an isError receipt has nothing to decode).
            const refundMessage =
              receipt.isSuccess && receipt.data ? ` ${refundFeedbackMessage(decodeRefundOutcome(receipt.data.logs, pendingTx.cloneAddress))}` : "";
            snackbar.show(`Record revoked.${refundMessage}`, "ok");
          } else {
            // Genuine bug this same gap exposed here too (mirroring TagsTable.tsx's own fix): this
            // handler never checked `r.ok` before this fix, so a confirmed-REVERTED revoke would
            // have shown a false "Record revoked" snackbar instead of an honest failure.
            const message = body?.error?.message ?? "Revoke transaction failed";
            snackbar.show(message, "danger");
            setFailedRevoke({recordId: pendingTx.recordId, hash: pendingTx.hash, message});
          }
          setPendingTx(null);
          load();
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, receipt.isError]);

  async function handleRevoke(record: RecordArtifactDoc) {
    if (!address || !record.chain.contract) return;
    const reasonCode = reasonByRecord[record.recordId] ?? REASON_CODES[0].name;
    setBusyRecordId(record.recordId);
    setFailedRevoke(null);
    try {
      const hash = await writeContractAsync(
        await legacyTxWithGas(publicClient, {
          address: record.chain.contract as `0x${string}`,
          abi: vetIssuerAbi,
          functionName: "revokeRecord",
          args: [record.root as `0x${string}`, reasonCodeHash(reasonCode)],
          account: address,
        }),
      );
      setPendingTx({hash, recordId: record.recordId, cloneAddress: record.chain.contract, reasonCode});
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Transaction failed", "danger");
    } finally {
      setBusyRecordId(null);
    }
  }

  async function handleRetryConfirm(record: RecordArtifactDoc) {
    setRetryingRecordId(record.recordId);
    try {
      const res = await fetch(`/api/records/${record.recordId}/confirm`, {method: "POST"});
      if (res.status === 202) {
        snackbar.show("Still waiting on the chain - try again shortly.", "info");
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        snackbar.show(body?.error?.message ?? "Confirmation failed", "danger");
        return;
      }
      snackbar.show(body.status === "active" ? "Record confirmed active" : "Reconciled", "ok");
      load();
    } finally {
      setRetryingRecordId(null);
    }
  }

  if (records === null) return <p className="text-body text-ink-faint">Loading...</p>;

  return (
    <div className="space-y-6">
      {!dogTagIssued && (
        <Banner tone="warn" title="This pet has no issued DogTag yet">
          Issue a tag for this pet before issuing a vaccination record - a record is bound to the pet&apos;s own DogTag id.
        </Banner>
      )}

      {!showForm && (
        <div className="flex justify-end">
          <Button onClick={() => setShowForm(true)} disabled={!dogTagIssued}>
            Issue vaccination record
          </Button>
        </div>
      )}

      {showForm && (
        <IssueRecordForm
          petId={petId}
          onDone={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      <DataTable
        columns={[
          {key: "disease", header: "Disease", render: (r: RecordArtifactDoc) => leafValue(r, "targetDisease")},
          {key: "product", header: "Product", render: (r: RecordArtifactDoc) => leafValue(r, "vaccineProductName")},
          {
            key: "vaccinationDate",
            header: "Vaccination date",
            render: (r: RecordArtifactDoc) => {
              const v = leafValue(r, "vaccinationDate");
              return v === "-" ? v : formatIsoCalendarDate(v);
            },
          },
          {
            key: "validity",
            header: "Validity",
            render: (r: RecordArtifactDoc) => {
              // leafValue's "-" is a display sentinel for "no such leaf", not a real date - this
              // deployment's own rows always have both in storage (the issuance form requires
              // them), so this only matters for pre-validation legacy data; computeRecordValidity
              // reports that honestly as "hidden" rather than a bare, unlabeled "-".
              const validFromRaw = leafValue(r, "validFrom");
              const validUntilRaw = leafValue(r, "validUntil");
              const validity = computeRecordValidity(
                r.status,
                validFromRaw === "-" ? undefined : validFromRaw,
                validUntilRaw === "-" ? undefined : validUntilRaw,
              );
              return <StatusBadge tone={recordValidityTone[validity]} label={recordValidityLabel[validity]} />;
            },
          },
          {
            key: "status",
            header: "Status",
            render: (r: RecordArtifactDoc) => <StatusBadge tone={recordStatusTone[r.status]} label={recordStatusLabel[r.status]} />,
          },
          {
            key: "anchoring",
            header: "Anchoring",
            render: (r: RecordArtifactDoc) =>
              r.chain.txHash ? (
                <div className="flex flex-col gap-0.5">
                  <HashCell value={r.chain.txHash} chain="roax" kind="tx" label="tx" />
                  {r.chain.blockNumber != null && (
                    <span className="text-caption text-ink-faint">
                      block {r.chain.blockNumber}
                      {r.chain.blockTime ? ` - ${formatUnixSeconds(Math.floor(new Date(r.chain.blockTime).getTime() / 1000), timeZone)}` : ""}
                    </span>
                  )}
                </div>
              ) : (
                "-"
              ),
          },
          {
            key: "actions",
            header: "Actions",
            render: (r: RecordArtifactDoc) => (
              <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setExpanded((prev) => (prev?.recordId === r.recordId && prev.kind === "details" ? null : {recordId: r.recordId, kind: "details"}))
                  }
                >
                  {expanded?.recordId === r.recordId && expanded.kind === "details" ? "Hide details" : "Details"}
                </Button>

                {r.status === "active" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setExpanded((prev) => (prev?.recordId === r.recordId && prev.kind === "export" ? null : {recordId: r.recordId, kind: "export"}))
                    }
                  >
                    {expanded?.recordId === r.recordId && expanded.kind === "export" ? "Hide export" : "Export to phone"}
                  </Button>
                )}

                {(r.status === "error" || r.status === "issuing") && (
                  // "issuing" gets this too, not only "error" (advisor review finding): a vet who
                  // closes the tab mid-flow (or navigates away before IssueRecordForm's own receipt
                  // effect fires) otherwise leaves a row permanently reading "Issuing" with no
                  // action at all until the worker's boot-recovery staleness clock eventually burns
                  // it to "error" - `confirm`'s own route already accepts an "issuing" record.
                  <Button variant="secondary" size="sm" disabled={retryingRecordId === r.recordId} onClick={() => handleRetryConfirm(r)}>
                    Retry confirm
                  </Button>
                )}

                {r.status === "active" && (
                  <>
                    {r.attestation ? (
                      <Button variant="ghost" size="sm" onClick={() => downloadAttestation(r)}>
                        Download attestation
                      </Button>
                    ) : null}
                    <Select
                      className="w-auto"
                      value={reasonByRecord[r.recordId] ?? REASON_CODES[0].name}
                      onChange={(e) => setReasonByRecord((v) => ({...v, [r.recordId]: e.target.value as ReasonCodeName}))}
                      aria-label="Reason code"
                    >
                      {REASON_CODES.map((rc) => (
                        <option key={rc.name} value={rc.name}>
                          {rc.label}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busyRecordId === r.recordId || chainId !== roax.id}
                      onClick={() => handleRevoke(r)}
                    >
                      Revoke
                    </Button>
                  </>
                )}
              </div>
              {failedRevoke?.recordId === r.recordId && (
                <Banner tone="danger" title="Transaction failed">
                  <p>{failedRevoke.message}</p>
                  <div className="mt-2">
                    <HashCell value={failedRevoke.hash} chain="roax" kind="tx" label="failed tx" />
                  </div>
                </Banner>
              )}
              </div>
            ),
          },
        ]}
        rows={records}
        getRowKey={(r) => r.recordId}
        emptyMessage="No vaccination records yet."
        renderExpansion={(r) => {
          if (expanded?.recordId !== r.recordId) return null;
          if (expanded.kind === "export") {
            return <MaskedRecordExportPanel petId={petId} recordId={r.recordId} onClose={() => setExpanded(null)} />;
          }
          return <RecordDetailPanel leaves={r.leaves} conformsTo={r.conformsTo} />;
        }}
      />
    </div>
  );
}
