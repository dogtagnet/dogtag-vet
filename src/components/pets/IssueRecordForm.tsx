"use client";

import {useEffect, useState} from "react";
import {useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {recordTypeKey} from "@dogtag/standard";
import {Banner} from "@/components/ui/Banner";
import {Button, Input, Select} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {HashCell} from "@/components/ui/HashCell";
import {useSnackbar} from "@/components/ui/Snackbar";
import {vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTxWithGas} from "@/lib/chainWrite";
import {decodeRefundOutcome, refundFeedbackMessage, type RefundOutcome} from "@/lib/refundFeedback";
import {recordStatusLabel, recordStatusTone} from "@/lib/recordStatusTone";
import {KNOWN_RECORD_STANDARDS} from "@/lib/records/standards";
import type {RecordArtifactDoc} from "@/lib/models/RecordArtifact";

const initialForm = {
  targetDisease: "",
  targetDiseaseCode: "",
  vaccineProductName: "",
  vaccineProductCode: "",
  vaccineManufacturer: "",
  batchLotNumber: "",
  vaccinationDate: "",
  validFrom: "",
  validUntil: "",
  nextDueDate: "",
  series: "" as "" | "primary" | "booster",
  route: "",
  site: "",
  doseQuantity: "",
  vaccineExpirationDate: "",
};

/**
 * The inline "Issue vaccination record" wizard on the pet page's Records tab (plan section 11.2 V3's
 * flow, surfaced here as V4's UI) - the record sibling of `/tags/issue/TagIssueWizard.tsx`, simpler
 * in exactly the ways `RecordArtifact.ts`'s own header states: no owner-device QR bind ceremony (a
 * record carries no owner-control leaves to bind - the server computes the full leaf set and root
 * SYNCHRONOUSLY from this form), so the flow is just create (draft) -> issue on chain -> confirm ->
 * optionally sign the C3 attestation, with no polling loop for a second device to catch up to.
 */
export function IssueRecordForm({petId, onDone}: {petId: string; onDone: () => void}) {
  const {address, isConnected, chainId} = useAccount();
  const {switchChain} = useSwitchChain();
  const {writeContractAsync} = useWriteContract();
  const publicClient = usePublicClient();
  const {signTypedDataAsync} = useSignTypedData();
  const snackbar = useSnackbar();

  const [form, setForm] = useState(initialForm);
  const [conformsTo, setConformsTo] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [record, setRecord] = useState<RecordArtifactDoc | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [lastIssueError, setLastIssueError] = useState<string | undefined>(undefined);
  // WP4.19 V5 - the dead tx hash kept for the record after a confirmed revert, mirroring
  // TagIssueWizard.tsx's own `lastFailedTxHash` (2026-09-25 incident fix round 2): the confirm
  // route deliberately clears `chain.txHash` server-side on a reverted outcome (`confirm/route.ts`'s
  // own `txHash: undefined` in its "reverted" branch), so this is the ONE place that hash survives
  // client-side for the "Transaction failed" banner below to still show it.
  const [lastFailedTxHash, setLastFailedTxHash] = useState<string | undefined>(undefined);
  const [attestationSigned, setAttestationSigned] = useState(false);
  const [refundOutcome, setRefundOutcome] = useState<RefundOutcome | null>(null);

  const receipt = useWaitForTransactionReceipt({hash: pendingTxHash, chainId: roax.id});

  function toggleConformsTo(id: string) {
    setConformsTo((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate() {
    if (!address) {
      snackbar.show("Connect your wallet first", "danger");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`/api/pets/${petId}/records`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          operatorAddress: address,
          form: {
            ...form,
            targetDiseaseCode: form.targetDiseaseCode || undefined,
            vaccineProductCode: form.vaccineProductCode || undefined,
            nextDueDate: form.nextDueDate || undefined,
            series: form.series || undefined,
            route: form.route || undefined,
            site: form.site || undefined,
            doseQuantity: form.doseQuantity || undefined,
            vaccineExpirationDate: form.vaccineExpirationDate || undefined,
          },
          conformsTo: KNOWN_RECORD_STANDARDS.filter((s) => conformsTo.has(`${s.id}@${s.version}`)).map((s) => ({standard: s.id, version: s.version})),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        snackbar.show(body?.error?.message ?? "Could not create this record", "danger");
        return;
      }
      setRecord(body.record);
    } finally {
      setCreating(false);
    }
  }

  async function handleIssue() {
    if (!record?.root || !address) return;
    if (chainId !== roax.id) {
      switchChain({chainId: roax.id});
      return;
    }
    if (record.chain.operator && record.chain.operator.toLowerCase() !== address.toLowerCase()) {
      // Client-side half of the wallet-switch guard (`api/records/[id]/tx/route.ts`'s own doc
      // comment names the server-side half) - catch a wallet switch BEFORE broadcasting a
      // transaction that the server would refuse to record anyway, rather than after.
      snackbar.show(`Reconnect the wallet this record was drafted for (${record.chain.operator}) before issuing.`, "danger");
      return;
    }
    setIssuing(true);
    setLastIssueError(undefined);
    setLastFailedTxHash(undefined);
    setRefundOutcome(null);
    try {
      const hash = await writeContractAsync(
        await legacyTxWithGas(publicClient, {
          address: record.chain.contract as `0x${string}`,
          abi: vetIssuerAbi,
          // issueRecord(bytes32 recordType, bytes32 root) - recordType FIRST, matching the ABI
          // exactly (never (root, recordType) - the reversed order a tag's issueTag(dogTagId, root)
          // might suggest by analogy).
          functionName: "issueRecord",
          args: [recordTypeKey("VACCINATION") as `0x${string}`, record.root as `0x${string}`],
          account: address,
        }),
      );
      await fetch(`/api/records/${record.recordId}/tx`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({txHash: hash, operatorAddress: address}),
      });
      setRecord((prev) => (prev ? {...prev, status: "issuing"} : prev));
      setPendingTxHash(hash);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Issuance transaction failed", "danger");
    } finally {
      setIssuing(false);
    }
  }

  async function runConfirm() {
    if (!record) return;
    setConfirming(true);
    try {
      const res = await fetch(`/api/records/${record.recordId}/confirm`, {method: "POST"});
      const body = await res.json().catch(() => null);
      if (res.status === 202) return; // transient - the vet can retry from the Records list later
      if (!res.ok) {
        snackbar.show(body?.error?.message ?? "Confirmation failed", "danger");
        setRecord((prev) => (prev ? {...prev, status: "error"} : prev));
        return;
      }
      if (body.status === "draft") {
        // A CONFIRMED revert - `reconcile.ts`'s own documented design decision: back to draft, no
        // redraft needed (leaves/root already verified), so the SAME record can retry immediately.
        // WP4.19 V5 - kept hash before it is cleared below, mirroring TagIssueWizard.tsx's own
        // `lastFailedTxHash` (`lastFailedTxHash`'s own doc comment above).
        setLastFailedTxHash(pendingTxHash);
        setLastIssueError(body.lastIssueError);
        setPendingTxHash(undefined);
        setRefundOutcome(null);
        setRecord((prev) => (prev ? {...prev, status: "draft", chain: {...prev.chain, txHash: undefined}} : prev));
        return;
      }
      snackbar.show("Record issued on chain", "ok");
      // WP4.19 V2 - only reachable once the receipt actually resolved `isSuccess` (the `draft`
      // branch above is what an `isError`/reverted receipt reconciles to instead), so `receipt.data`
      // is always the successful receipt's own logs here.
      if (receipt.data && record?.chain.contract) {
        setRefundOutcome(decodeRefundOutcome(receipt.data.logs, record.chain.contract));
      }
      setRecord((prev) => (prev ? {...prev, status: "active", chain: {...prev.chain, contract: body.contract ?? prev.chain.contract}} : prev));
    } finally {
      setConfirming(false);
    }
  }

  // `isError` too, not just `isSuccess` (WP4.19 V5, replicating the 2026-09-25 incident fix round
  // 2 exactly - `@wagmi/core`'s `waitForTransactionReceipt` throws instead of resolving for a
  // REVERTED receipt, so `isSuccess` alone left a reverted `issueRecord` stuck on "Waiting for the
  // transaction to confirm..." forever, reproduced directly before this fix). `runConfirm` itself
  // already re-reads the chain via `reconcileAnchoredRecord` regardless of which outcome triggered
  // it ("a receipt is not proof"), so calling it on `isError` is exactly as safe as `isSuccess`
  // already was.
  useEffect(() => {
    if (receipt.isSuccess || receipt.isError) void runConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, receipt.isError]);

  async function handleSignAttestation() {
    if (!record) return;
    const payloadRes = await fetch(`/api/records/${record.recordId}/attestation`);
    const payload = await payloadRes.json().catch(() => null);
    if (!payloadRes.ok) {
      snackbar.show(payload?.error?.message ?? "Could not build the attestation payload", "danger");
      return;
    }
    try {
      const signature = await signTypedDataAsync({domain: payload.domain, types: payload.types, primaryType: "IssuerAttestation", message: payload.message});
      const storeRes = await fetch(`/api/records/${record.recordId}/attestation`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({signature}),
      });
      const storeBody = await storeRes.json().catch(() => null);
      if (!storeRes.ok) {
        snackbar.show(storeBody?.error?.message ?? "Could not store the signed attestation", "danger");
        return;
      }
      snackbar.show("Issuer attestation signed and stored", "ok");
      setAttestationSigned(true);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Signature was rejected", "danger");
    }
  }

  if (!isConnected) {
    return (
      <Banner tone="warn" title="Connect your operator wallet">
        Issuing a vaccination record requires a connected wallet whitelisted on this clinic&apos;s clone.
      </Banner>
    );
  }

  if (record) {
    const walletMismatch = Boolean(record.chain.operator && address && record.chain.operator.toLowerCase() !== address.toLowerCase());
    return (
      <FormSection title="Issue vaccination record" helperText="Status updates automatically once the transaction is sent.">
        <div className="flex items-center gap-3">
          <StatusBadge tone={recordStatusTone[record.status]} label={recordStatusLabel[record.status]} />
          <HashCell value={record.root} kind="root" label="root" />
          {record.chain.txHash && <HashCell value={record.chain.txHash} chain="roax" kind="tx" label="tx" />}
        </div>

        {record.status === "error" && (
          <div className="mt-4 space-y-3">
            <Banner tone="danger" title="On-chain confirmation did not match">
              The chain did not agree this record was anchored. It may simply need a moment, or the previous attempt may never have
              been sent - try Retry confirm first; only send a fresh transaction if that still refuses.
            </Banner>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={runConfirm} disabled={confirming}>
                {confirming ? "Checking..." : "Retry confirm"}
              </Button>
            </div>
          </div>
        )}

        {(record.status === "draft" || record.status === "error") && (
          <div className="mt-4 space-y-3">
            {lastIssueError && (
              // WP4.19 V5 - "Transaction failed" (was "Previous attempt did not confirm"),
              // matching TagIssueWizard.tsx's own 2026-09-25 incident-fix-round-2 wording exactly -
              // Kenneth's explicit UX ask applied here too, plus the dead tx kept for the record
              // (copyable, explorer-linked) the way that fix's own banner already does.
              <Banner tone="danger" title="Transaction failed">
                <p>{lastIssueError}</p>
                {lastFailedTxHash && (
                  <div className="mt-2">
                    <HashCell value={lastFailedTxHash} chain="roax" kind="tx" label="failed tx" />
                  </div>
                )}
              </Banner>
            )}
            {walletMismatch && (
              <Banner tone="warn" title="Wrong wallet connected">
                This record was drafted for {record.chain.operator}. Reconnect that wallet to issue it.
              </Banner>
            )}
            <p className="text-caption text-ink-faint">
              Gas is fronted by your wallet and refunded by the clinic&apos;s clone on success (failed attempts are not refunded).
            </p>
            <Button onClick={handleIssue} disabled={issuing || walletMismatch}>
              {issuing ? "Issuing..." : "Issue on chain"}
            </Button>
          </div>
        )}

        {record.status === "issuing" && <p className="mt-4 text-body text-ink-muted">Waiting for the transaction to confirm...</p>}

        {record.status === "active" && (
          <div className="mt-4 space-y-3">
            <p className="text-body text-ok">Record issued successfully.</p>
            {/* WP4.19 V2 - whether the clinic's clone refunded the gas this wallet fronted. */}
            {refundOutcome && <p className="text-caption text-ink-muted">{refundFeedbackMessage(refundOutcome)}</p>}
            {record.attestation || attestationSigned ? (
              <StatusBadge label="Issuer attestation signed" tone="ok" />
            ) : (
              <Button onClick={handleSignAttestation}>Sign issuer attestation</Button>
            )}
            <div>
              <Button variant="secondary" onClick={onDone}>
                Done
              </Button>
            </div>
          </div>
        )}
      </FormSection>
    );
  }

  return (
    <FormSection title="Issue vaccination record">
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Target disease" htmlFor="targetDisease">
          <Input id="targetDisease" value={form.targetDisease} onChange={(e) => setForm((v) => ({...v, targetDisease: e.target.value}))} placeholder="Rabies" />
        </FormField>
        <FormField label="Target disease code" htmlFor="targetDiseaseCode" helperText="Optional">
          <Input id="targetDiseaseCode" value={form.targetDiseaseCode} onChange={(e) => setForm((v) => ({...v, targetDiseaseCode: e.target.value}))} />
        </FormField>
        <FormField label="Vaccine product" htmlFor="vaccineProductName">
          <Input id="vaccineProductName" value={form.vaccineProductName} onChange={(e) => setForm((v) => ({...v, vaccineProductName: e.target.value}))} />
        </FormField>
        <FormField label="Vaccine product code" htmlFor="vaccineProductCode" helperText="Optional">
          <Input id="vaccineProductCode" value={form.vaccineProductCode} onChange={(e) => setForm((v) => ({...v, vaccineProductCode: e.target.value}))} />
        </FormField>
        <FormField label="Manufacturer" htmlFor="vaccineManufacturer">
          <Input id="vaccineManufacturer" value={form.vaccineManufacturer} onChange={(e) => setForm((v) => ({...v, vaccineManufacturer: e.target.value}))} />
        </FormField>
        <FormField label="Batch / lot number" htmlFor="batchLotNumber">
          <Input id="batchLotNumber" value={form.batchLotNumber} onChange={(e) => setForm((v) => ({...v, batchLotNumber: e.target.value}))} />
        </FormField>
        <FormField label="Vaccination date" htmlFor="vaccinationDate">
          <Input id="vaccinationDate" type="date" value={form.vaccinationDate} onChange={(e) => setForm((v) => ({...v, vaccinationDate: e.target.value}))} />
        </FormField>
        <FormField label="Series" htmlFor="series" helperText="Optional">
          <Select id="series" value={form.series} onChange={(e) => setForm((v) => ({...v, series: e.target.value as typeof form.series}))}>
            <option value="">Unspecified</option>
            <option value="primary">Primary</option>
            <option value="booster">Booster</option>
          </Select>
        </FormField>
        <FormField label="Valid from" htmlFor="validFrom">
          <Input id="validFrom" type="date" value={form.validFrom} onChange={(e) => setForm((v) => ({...v, validFrom: e.target.value}))} />
        </FormField>
        <FormField label="Valid until" htmlFor="validUntil" helperText="Valid through the end of this date, UTC">
          <Input id="validUntil" type="date" value={form.validUntil} onChange={(e) => setForm((v) => ({...v, validUntil: e.target.value}))} />
        </FormField>
        <FormField label="Next due date" htmlFor="nextDueDate" helperText="Optional">
          <Input id="nextDueDate" type="date" value={form.nextDueDate} onChange={(e) => setForm((v) => ({...v, nextDueDate: e.target.value}))} />
        </FormField>
        <FormField label="Route" htmlFor="route" helperText="Optional, e.g. subcutaneous">
          <Input id="route" value={form.route} onChange={(e) => setForm((v) => ({...v, route: e.target.value}))} />
        </FormField>
        <FormField label="Site" htmlFor="site" helperText="Optional, e.g. left hind limb">
          <Input id="site" value={form.site} onChange={(e) => setForm((v) => ({...v, site: e.target.value}))} />
        </FormField>
        <FormField label="Dose quantity" htmlFor="doseQuantity" helperText="Optional, e.g. 1 or 0.5">
          <Input id="doseQuantity" value={form.doseQuantity} onChange={(e) => setForm((v) => ({...v, doseQuantity: e.target.value}))} />
        </FormField>
        <FormField label="Vaccine expiration date" htmlFor="vaccineExpirationDate" helperText="Optional - the vial's own expiry">
          <Input
            id="vaccineExpirationDate"
            type="date"
            value={form.vaccineExpirationDate}
            onChange={(e) => setForm((v) => ({...v, vaccineExpirationDate: e.target.value}))}
          />
        </FormField>
      </div>

      <FormField label="Conforms to" htmlFor="conformsTo" helperText="Optional - the vet's own claim that this record was filled out to satisfy a known external standard. Descriptive only, never verified against the leaves.">
        <div id="conformsTo" className="space-y-1.5">
          {KNOWN_RECORD_STANDARDS.map((s) => {
            const key = `${s.id}@${s.version}`;
            return (
              <label key={key} className="flex items-center gap-2 text-body text-ink">
                <input type="checkbox" checked={conformsTo.has(key)} onChange={() => toggleConformsTo(key)} />
                {s.name}
              </label>
            );
          })}
        </div>
      </FormField>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          onClick={handleCreate}
          disabled={creating || !form.targetDisease || !form.vaccineProductName || !form.vaccineManufacturer || !form.batchLotNumber || !form.vaccinationDate || !form.validFrom || !form.validUntil}
        >
          {creating ? "Creating..." : "Create draft"}
        </Button>
      </div>
    </FormSection>
  );
}
