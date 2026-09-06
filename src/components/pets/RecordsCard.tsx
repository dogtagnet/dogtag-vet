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
  const [pendingTx, setPendingTx] = useState<{hash: `0x${string}`; recordId: string; reasonCode: ReasonCodeName} | null>(null);

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
    if (receipt.isSuccess && pendingTx) {
      fetch(`/api/records/${pendingTx.recordId}/lifecycle`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({reasonCode: pendingTx.reasonCode, txHash: pendingTx.hash}),
      })
        .then((r) => r.json())
        .then(() => {
          snackbar.show("Record revoked", "ok");
          setPendingTx(null);
          load();
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  async function handleRevoke(record: RecordArtifactDoc) {
    if (!address || !record.chain.contract) return;
    const reasonCode = reasonByRecord[record.recordId] ?? REASON_CODES[0].name;
    setBusyRecordId(record.recordId);
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
      setPendingTx({hash, recordId: record.recordId, reasonCode});
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
              const validUntil = leafValue(r, "validUntil");
              if (validUntil === "-") return "-";
              const validity = computeRecordValidity(r.status, validUntil);
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
