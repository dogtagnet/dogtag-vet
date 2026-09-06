"use client";

import {useEffect, useRef, useState} from "react";
import {useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {Banner} from "@/components/ui/Banner";
import {Button, Input, Select} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {QrSurface} from "@/components/ui/QrSurface";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {HashCell} from "@/components/ui/HashCell";
import {useSnackbar} from "@/components/ui/Snackbar";
import {verificationRegistryConsentAbi, vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTxWithGas} from "@/lib/chainWrite";
import {publicEnv} from "@/lib/env.public";
import {verifySessionStatusLabel, verifySessionStatusTone} from "@/lib/verifySessionTone";
import type {PetDoc} from "@/lib/models/Pet";
import type {VerifySessionStatus} from "@/lib/models/VerifySession";

interface SessionState {
  sessionId: string;
  status: VerifySessionStatus;
  purpose: string;
  recordType: string;
  relayerAddress: string;
  challenge: {dogTagId: string; deadline: number; consentNonce: string};
  proof?: {a: [string, string]; b: [[string, string], [string, string]]; c: [string, string]; pubSignals: string[]};
  txHash?: string;
  nullifier?: string;
}

/**
 * `/verify` - wp4-vet.md's relayer flow: staff starts a session (purpose/recordType/pet), the
 * connected wallet acts as the relayer, the owner's device resolves the `/x/<token>?a=<relayer>`
 * QR and posts a proof, and the staff wallet submits `recordVerificationZK` once it arrives.
 *
 * WP4.15 multi-owner (PLANNED) item V5: an OPTIONAL, clinic-wide-defaulted mode targets the
 * clinic's own clone as the relayer instead (`docs/DELEGATION.md` section 7's "relayVerification
 * is a new relayer") - `useClone` below, initialized from `consentRelayerViaCloneEnabled`
 * (Settings) but independently toggleable per session. When on: `handleStart` posts the CLONE's
 * address as `relayerAddress` (so the phone's proof targets it, and `POST /api/verify/start`'s
 * existing, UNMODIFIED `readCanVerify` preflight fails closed with a clear message if the admin
 * has not yet whitelisted this clone - exactly the same gate an unwhitelisted staff wallet already
 * hits today); `handleSubmit` calls the clone's `relayVerification` instead of
 * `recordVerificationZK` directly, so the operator wallet (which already holds gas and is already
 * whitelisted as an OPERATOR, a completely separate axis from `canVerify`) submits the tx while
 * the CLONE is what `VerificationRegistryConsent` sees as `msg.sender`.
 */
export function VerifySessionPanel({
  cloneAddress,
  consentRelayerViaCloneEnabled,
}: {
  cloneAddress?: string;
  consentRelayerViaCloneEnabled: boolean;
}) {
  const {address, chainId} = useAccount();
  const {writeContractAsync} = useWriteContract();
  const publicClient = usePublicClient();
  const snackbar = useSnackbar();

  const [useClone, setUseClone] = useState(consentRelayerViaCloneEnabled);
  const [purpose, setPurpose] = useState("");
  const [recordType, setRecordType] = useState("DOG_PROFILE");
  const [petQuery, setPetQuery] = useState("");
  const [petResults, setPetResults] = useState<PetDoc[]>([]);
  const [selectedPet, setSelectedPet] = useState<PetDoc | null>(null);
  const [starting, setStarting] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>(undefined);

  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const receipt = useWaitForTransactionReceipt({hash: pendingTxHash, chainId: roax.id});

  useEffect(() => {
    if (!petQuery.trim()) {
      setPetResults([]);
      return;
    }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/pets?q=${encodeURIComponent(petQuery.trim())}`);
      if (res.ok) setPetResults(await res.json());
    }, 250);
    return () => clearTimeout(t);
  }, [petQuery]);

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
  }
  useEffect(() => stopPolling, []);

  async function handleStart() {
    if (!address || !selectedPet) return;
    const relayerAddress = useClone && cloneAddress ? cloneAddress : address;
    setStarting(true);
    try {
      const res = await fetch("/api/verify/start", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          purpose,
          recordType,
          relayerAddress,
          petId: selectedPet.petId,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        snackbar.show(body?.error?.message ?? "Could not start verification", "danger");
        return;
      }
      setQr(body.qr);
      stopPolling();
      pollRef.current = setInterval(async () => {
        const r = await fetch(`/api/verify/${body.sessionId}`);
        if (r.ok) setSession(await r.json());
      }, 2000);
    } finally {
      setStarting(false);
    }
  }

  async function handleSubmit() {
    if (!session?.proof || !address) return;
    setSubmitting(true);
    try {
      const a = session.proof.a.map(BigInt) as [bigint, bigint];
      const b = session.proof.b.map((pair) => pair.map(BigInt)) as [[bigint, bigint], [bigint, bigint]];
      const c = session.proof.c.map(BigInt) as [bigint, bigint];
      const pub = session.proof.pubSignals.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint];

      // The relayer this session was STARTED with decides the write path - `session.relayerAddress`
      // (server-trusted, from the session row) rather than re-reading `useClone` here, since the
      // toggle could in principle change between starting a session and submitting its proof.
      const viaClone = Boolean(cloneAddress) && session.relayerAddress.toLowerCase() === cloneAddress?.toLowerCase();
      const hash = await writeContractAsync(
        // Headroom over the bare estimate - see legacyTxWithGas's doc comment for the incident
        // txs the refund tail starved at the wallet's own estimate.
        await legacyTxWithGas(
          publicClient,
          viaClone
            ? {address: cloneAddress as `0x${string}`, abi: vetIssuerAbi, functionName: "relayVerification", args: [a, b, c, pub], account: address}
            : {
                address: publicEnv.verificationRegistryAddress as `0x${string}`,
                abi: verificationRegistryConsentAbi,
                functionName: "recordVerificationZK",
                args: [a, b, c, pub],
                account: address,
              },
        ),
      );
      setPendingTxHash(hash);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Submission failed", "danger");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (receipt.isSuccess && session?.sessionId && pendingTxHash) {
      fetch(`/api/verify/${session.sessionId}/recorded`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({txHash: pendingTxHash}),
      }).then(() => snackbar.show("Verification recorded on chain", "ok"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  if (!address) {
    return (
      <Banner tone="warn" title="Connect your wallet">
        Verifying consent requires a connected wallet with `canVerify` capability for this purpose.
      </Banner>
    );
  }

  if (qr && session) {
    return (
      <div className="max-w-2xl space-y-6">
        <FormSection title="Verification session">
          <div className="flex items-center gap-3">
            <StatusBadge tone={verifySessionStatusTone[session.status]} label={verifySessionStatusLabel[session.status]} />
            {session.txHash && <HashCell value={session.txHash} chain="roax" kind="tx" label="tx" />}
          </div>
          {session.status === "pending" && (
            <div className="mt-4 flex justify-center">
              <QrSurface data={qr} caption="Scan with the owner's DogTag app" expiresAt={session.challenge.deadline} />
            </div>
          )}
          {session.status === "proof_received" && (
            <div className="mt-4">
              <p className="mb-3 text-body text-ink-muted">A proof was received. Submit it on chain.</p>
              <Button onClick={handleSubmit} disabled={submitting || chainId !== roax.id}>
                {submitting ? "Submitting..." : "Submit consent proof"}
              </Button>
            </div>
          )}
          {session.status === "recorded" && (
            <p className="mt-4 text-body text-ok">Consent recorded. Nullifier: {session.nullifier}</p>
          )}
        </FormSection>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <FormSection title="Start a verification" helperText="The connected wallet acts as the relayer.">
        <FormField label="Purpose" htmlFor="purpose" helperText="A short identifier, e.g. BOARDING_CHECKIN">
          <Input id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </FormField>
        <FormField label="Record type" htmlFor="recordType">
          <Select id="recordType" value={recordType} onChange={(e) => setRecordType(e.target.value)}>
            <option value="DOG_PROFILE">DOG_PROFILE</option>
            <option value="VACCINATION">VACCINATION</option>
            <option value="TRAVEL_CLEARANCE">TRAVEL_CLEARANCE</option>
          </Select>
        </FormField>
        <FormField label="Pet" htmlFor="pet-search" helperText="The pet whose tag will be verified.">
          <div className="relative">
            <Input
              id="pet-search"
              value={selectedPet ? selectedPet.name : petQuery}
              onChange={(e) => {
                setSelectedPet(null);
                setPetQuery(e.target.value);
              }}
              placeholder="Search pets"
            />
            {!selectedPet && petResults.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full rounded-control border border-border bg-surface shadow-raised">
                {petResults.map((p) => (
                  <li key={p.petId}>
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left text-body hover:bg-surface-2"
                      onClick={() => {
                        setSelectedPet(p);
                        setPetResults([]);
                      }}
                    >
                      {p.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </FormField>
        {cloneAddress && (
          <FormField
            label="Use this clinic's clone as the relayer"
            htmlFor="use-clone-relayer"
            helperText="Experimental (WP4.15) - needs the DogTag admin to separately whitelist this clone for canVerify. Off uses your connected wallet as the relayer, as before."
          >
            <input id="use-clone-relayer" type="checkbox" checked={useClone} onChange={(e) => setUseClone(e.target.checked)} />
          </FormField>
        )}
      </FormSection>
      <div className="flex justify-end">
        <Button onClick={handleStart} disabled={starting || !purpose || !selectedPet}>
          {starting ? "Starting..." : "Start verification"}
        </Button>
      </div>
    </div>
  );
}
