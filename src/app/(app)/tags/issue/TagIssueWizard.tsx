"use client";

import {useEffect, useRef, useState} from "react";
import {useSearchParams} from "next/navigation";
import {useAccount, useSignTypedData, useSwitchChain, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {Banner} from "@/components/ui/Banner";
import {Button, Input, Select} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {QrSurface} from "@/components/ui/QrSurface";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {HashCell} from "@/components/ui/HashCell";
import {WeightHistoryEditor} from "@/components/pets/WeightHistoryEditor";
import {useSnackbar} from "@/components/ui/Snackbar";
import {vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTx} from "@/lib/chainWrite";
import {reasonCodeHash} from "@/lib/reasonCodes";
import type {ClientDoc} from "@/lib/models/Client";
import type {PetDoc, PetSex, WeightEntry} from "@/lib/models/Pet";

interface StartSessionResponse {
  token: string;
  dogTagId: string;
  dogTagIdField: string;
  sessionId: string;
  qr: string;
  ttlSecs: number;
}

interface SessionPoll {
  sessionId: string;
  dogTagId: string;
  dogTagIdField: string;
  petId?: string;
  status: "pending" | "ready" | "issuing" | "bound" | "error";
  root?: string;
  txHash?: string;
  errorStage?: string;
  errorReason?: string;
  token?: string;
  qr?: string;
  ttlSecs?: number;
}

const initialProfile = {
  species: "",
  breedVbo: "",
  breedLabel: "",
  sex: "" as PetSex | "",
  neuterStatus: "" as "" | "intact" | "neutered" | "spayed" | "unknown",
  dateOfBirth: "",
  weightHistory: [] as WeightEntry[],
};

/**
 * `/tags/issue` - wp4-vet.md's mint wizard end to end: pick/create client+pet and enter owner
 * identity + pet profile, start the session, show the QR while the owner's device binds, then
 * walk the operator wallet through `issueTag` -> on-chain confirm -> the C3 issuer attestation
 * signature. Every chain read/write here goes through the connected wallet - nothing is signed or
 * read server-side except the fail-closed preflight and allocation, which return their result as
 * plain JSON.
 */
export function TagIssueWizard() {
  const {address, isConnected, chainId} = useAccount();
  const {switchChain} = useSwitchChain();
  const {writeContractAsync} = useWriteContract();
  const {signTypedDataAsync} = useSignTypedData();
  const snackbar = useSnackbar();

  const [clientQuery, setClientQuery] = useState("");
  const [clientResults, setClientResults] = useState<ClientDoc[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientDoc | null>(null);
  const [pets, setPets] = useState<PetDoc[]>([]);
  const [petId, setPetId] = useState<string>("");
  const [petName, setPetName] = useState("");
  const [ownerIdentity, setOwnerIdentity] = useState({name: "", countryOfIdentification: "", identification: ""});
  const [profile, setProfile] = useState(initialProfile);
  const [microchipCode, setMicrochipCode] = useState("");

  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<SessionPoll | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>(undefined);

  // The replace wizard (wp4-vet.md: "replace ... start new mint session for the same pet, and
  // after the new tag binds, prompt revoke of the old tag with REASON_REPLACED"). `replacingPet`
  // holds the pet's PRE-replace tag state (root/cloneAddress/dogTagIdField) so the post-bind
  // revoke prompt below can send `revokeTag` against the tag being replaced, not the new one.
  const [replacingPet, setReplacingPet] = useState<PetDoc | null>(null);
  const [revokingPrevious, setRevokingPrevious] = useState(false);
  const [revokePrevTxHash, setRevokePrevTxHash] = useState<`0x${string}` | undefined>(undefined);
  const [previousTagRevoked, setPreviousTagRevoked] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const receipt = useWaitForTransactionReceipt({hash: pendingTxHash, chainId: roax.id});
  const revokePrevReceipt = useWaitForTransactionReceipt({hash: revokePrevTxHash, chainId: roax.id});
  const searchParams = useSearchParams();
  const resumeSessionId = searchParams.get("session");
  const replacePetId = searchParams.get("replace");

  useEffect(() => {
    if (!clientQuery.trim()) {
      setClientResults([]);
      return;
    }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/clients?q=${encodeURIComponent(clientQuery.trim())}`);
      if (res.ok) setClientResults(await res.json());
    }, 250);
    return () => clearTimeout(t);
  }, [clientQuery]);

  useEffect(() => {
    if (!selectedClient) {
      setPets([]);
      return;
    }
    fetch(`/api/pets?ownerClientId=${selectedClient.clientId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setPets);
  }, [selectedClient]);

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = undefined;
  }

  function startPolling(sessionId: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/tags/issue/${sessionId}`);
      if (res.ok) setSession(await res.json());
    }, 2000);
  }

  useEffect(() => stopPolling, []);

  // Resuming an in-progress session from the `/tags` page's "in progress" list (`?session=`) -
  // fetch its current state once, then fall into the same polling loop a freshly-started session
  // uses.
  useEffect(() => {
    if (!resumeSessionId) return;
    fetch(`/api/tags/issue/${resumeSessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (body) {
          setSession(body);
          startPolling(resumeSessionId);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeSessionId]);

  // Replace wizard entry point (`/tags/issue?replace=<petId>` from the Tags page): pre-select the
  // same pet and its owner, and remember the pet's current tag so the post-bind step below can
  // offer to revoke exactly that tag once the replacement is bound.
  useEffect(() => {
    if (!replacePetId || resumeSessionId) return;
    fetch(`/api/pets/${replacePetId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: (PetDoc & {owners: ClientDoc[]}) | null) => {
        if (!body) return;
        setReplacingPet(body);
        setPetId(body.petId);
        setPets([body]);
        if (body.owners[0]) setSelectedClient(body.owners[0]);
      });
  }, [replacePetId, resumeSessionId]);

  useEffect(() => {
    if (revokePrevReceipt.isSuccess && revokePrevTxHash && replacingPet) {
      fetch(`/api/tags/${replacingPet.petId}/lifecycle`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({action: "revoke", reasonCode: "REASON_REPLACED", txHash: revokePrevTxHash}),
      }).then(() => {
        snackbar.show("Previous tag revoked", "ok");
        setPreviousTagRevoked(true);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revokePrevReceipt.isSuccess]);

  async function handleRevokePrevious() {
    if (!replacingPet?.dogTag.cloneAddress || !replacingPet.dogTag.dogTagIdField || !address) return;
    setRevokingPrevious(true);
    try {
      const hash = await writeContractAsync(
        legacyTx({
          address: replacingPet.dogTag.cloneAddress as `0x${string}`,
          abi: vetIssuerAbi,
          functionName: "revokeTag",
          args: [BigInt(replacingPet.dogTag.dogTagIdField), reasonCodeHash("REASON_REPLACED")],
        }),
      );
      setRevokePrevTxHash(hash);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Revoking the previous tag failed", "danger");
    } finally {
      setRevokingPrevious(false);
    }
  }

  async function handleStart() {
    if (!address) {
      snackbar.show("Connect your wallet first", "danger");
      return;
    }
    const selectedPet = pets.find((p) => p.petId === petId);
    setStarting(true);
    try {
      const res = await fetch("/api/tags/issue/start", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          clientId: selectedClient?.clientId,
          petId: petId || undefined,
          petName: selectedPet?.name ?? petName,
          ownerIdentity,
          microchip: microchipCode ? {code: microchipCode} : undefined,
          profile: {
            ...profile,
            sex: profile.sex || undefined,
            neuterStatus: profile.neuterStatus || undefined,
          },
          operatorAddress: address,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        snackbar.show(body?.error?.message ?? "Could not start issuance", "danger");
        return;
      }
      const started = body as StartSessionResponse;
      setSession({
        sessionId: started.sessionId,
        dogTagId: started.dogTagId,
        dogTagIdField: started.dogTagIdField,
        status: "pending",
        token: started.token,
        qr: started.qr,
        ttlSecs: started.ttlSecs,
      });
      startPolling(started.sessionId);
    } finally {
      setStarting(false);
    }
  }

  async function handleIssue() {
    if (!session?.root || !session.dogTagIdField || !address) return;
    if (chainId !== roax.id) {
      switchChain({chainId: roax.id});
      return;
    }
    setIssuing(true);
    try {
      const settingsRes = await fetch("/api/settings");
      const settings = settingsRes.ok ? await settingsRes.json() : null;
      if (!settings?.cloneAddress) {
        snackbar.show("This clinic has not completed setup", "danger");
        return;
      }
      const hash = await writeContractAsync(
        legacyTx({
          address: settings.cloneAddress as `0x${string}`,
          abi: vetIssuerAbi,
          functionName: "issueTag",
          args: [BigInt(session.dogTagIdField), session.root as `0x${string}`],
        }),
      );
      await fetch(`/api/tags/issue/${session.sessionId}/tx`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({txHash: hash}),
      });
      setPendingTxHash(hash);
      startPolling(session.sessionId);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Issuance transaction failed", "danger");
    } finally {
      setIssuing(false);
    }
  }

  useEffect(() => {
    if (receipt.isSuccess && session?.sessionId) {
      fetch(`/api/tags/issue/${session.sessionId}/confirm`, {method: "POST"})
        .then((r) => r.json())
        .then((body) => {
          if (body.status === "bound") snackbar.show("Tag bound on chain", "ok");
          setSession((prev) => (prev ? {...prev, status: body.status ?? prev.status} : prev));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  async function handleSignAttestation() {
    if (!session?.sessionId || !address) return;
    const payloadRes = await fetch(`/api/tags/issue/${session.sessionId}/attestation`);
    if (!payloadRes.ok) {
      snackbar.show("Could not build the attestation payload", "danger");
      return;
    }
    const payload = await payloadRes.json();
    try {
      const signature = await signTypedDataAsync({
        domain: payload.domain,
        types: payload.types,
        primaryType: "IssuerAttestation",
        message: payload.message,
      });
      await fetch(`/api/tags/issue/${session.sessionId}/attestation`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({signature, issuerSigner: address}),
      });
      snackbar.show("Issuer attestation signed and stored", "ok");
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Signature was rejected", "danger");
    }
  }

  async function handleRetry() {
    if (!session?.sessionId || !address) return;
    const res = await fetch(`/api/tags/issue/${session.sessionId}/retry`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({operatorAddress: address}),
    });
    const body = await res.json();
    if (!res.ok) {
      snackbar.show(body?.error?.message ?? "Retry failed", "danger");
      return;
    }
    setSession({
      sessionId: body.sessionId,
      dogTagId: body.dogTagId,
      dogTagIdField: session.dogTagIdField,
      status: "pending",
      token: body.token,
      qr: body.qr,
      ttlSecs: body.ttlSecs,
    });
    startPolling(body.sessionId);
  }

  if (!isConnected) {
    return (
      <Banner tone="warn" title="Connect your operator wallet">
        Issuing a tag requires a connected wallet whitelisted on this clinic&apos;s clone.
      </Banner>
    );
  }

  if (session) {
    return (
      <div className="max-w-2xl space-y-6">
        <FormSection title={`Tag ${session.dogTagId}`} helperText="Session status updates automatically.">
          <div className="flex items-center gap-3">
            <StatusBadge
              tone={
                session.status === "bound"
                  ? "ok"
                  : session.status === "error"
                    ? "danger"
                    : session.status === "ready" || session.status === "issuing"
                      ? "info"
                      : "neutral"
              }
              label={session.status}
            />
            {session.root && <HashCell value={session.root} kind="root" label="root" />}
            {session.txHash && <HashCell value={session.txHash} chain="roax" kind="tx" label="tx" />}
          </div>

          {session.status === "pending" && session.qr && (
            <div className="mt-4 flex justify-center">
              <QrSurface data={session.qr} caption="Scan with the owner's DogTag app" expiresAt={Math.floor(Date.now() / 1000) + (session.ttlSecs ?? 0)} />
            </div>
          )}

          {session.status === "ready" && (
            <div className="mt-4">
              <p className="mb-3 text-body text-ink-muted">
                The device built and bound its profile tree. Issue this tag on chain from your operator wallet.
              </p>
              <Button onClick={handleIssue} disabled={issuing}>
                {issuing ? "Issuing..." : "Issue on chain"}
              </Button>
            </div>
          )}

          {session.status === "issuing" && (
            <p className="mt-4 text-body text-ink-muted">Waiting for the transaction to confirm...</p>
          )}

          {session.status === "bound" && (
            <div className="mt-4 space-y-4">
              <p className="text-body text-ok">Tag bound successfully.</p>
              <Button onClick={handleSignAttestation}>Sign issuer attestation</Button>
              {replacingPet?.dogTag.status === "active" && !previousTagRevoked && (
                <Banner tone="warn" title="Revoke the previous tag">
                  <p className="mb-3">
                    The new tag for {replacingPet.name} is bound. Revoke the previous tag with reason
                    &quot;Replaced by a new tag&quot; so it no longer verifies as active.
                  </p>
                  <Button
                    variant="danger"
                    disabled={revokingPrevious || chainId !== roax.id}
                    onClick={handleRevokePrevious}
                  >
                    Revoke previous tag
                  </Button>
                </Banner>
              )}
              {previousTagRevoked && <p className="text-body text-ok">Previous tag revoked.</p>}
            </div>
          )}

          {session.status === "error" && (
            <div className="mt-4 space-y-2">
              <Banner tone="danger" title={`Issuance failed (${session.errorStage ?? "unknown"})`}>
                {session.errorReason ?? "Something went wrong while issuing this tag."}
              </Banner>
              <Button onClick={handleRetry}>Retry with a fresh token</Button>
            </div>
          )}
        </FormSection>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <FormSection title="1. Client" helperText="Search for an existing client who owns this pet.">
        <div className="relative">
          <Input
            value={selectedClient ? selectedClient.name : clientQuery}
            onChange={(e) => {
              setSelectedClient(null);
              setClientQuery(e.target.value);
            }}
            placeholder="Search clients"
          />
          {!selectedClient && clientResults.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-control border border-border bg-surface shadow-raised">
              {clientResults.map((c) => (
                <li key={c.clientId}>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-body hover:bg-surface-2"
                    onClick={() => {
                      setSelectedClient(c);
                      setClientResults([]);
                    }}
                  >
                    {c.name} {c.email && <span className="text-ink-faint">({c.email})</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </FormSection>

      {selectedClient && (
        <FormSection title="2. Pet" helperText="Pick an existing pet of this client, or name a new one.">
          <FormField label="Existing pet" htmlFor="pet-select">
            <Select id="pet-select" value={petId} onChange={(e) => setPetId(e.target.value)}>
              <option value="">New pet</option>
              {pets.map((p) => (
                <option key={p.petId} value={p.petId}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
          {!petId && (
            <FormField label="New pet name" htmlFor="pet-name">
              <Input id="pet-name" value={petName} onChange={(e) => setPetName(e.target.value)} />
            </FormField>
          )}
          {petId && pets.find((p) => p.petId === petId)?.dogTag.status === "active" && (
            <Banner tone="warn" title="This pet already has an active tag">
              Issuing a new tag is the replace flow (wp4-vet.md): once this new tag is bound, revoke the
              previous one from the Tags page with reason code &quot;Replaced by a new tag&quot;.
            </Banner>
          )}
        </FormSection>
      )}

      {selectedClient && (petId || petName) && (
        <>
          <FormSection title="3. Owner identity" helperText="Server-generates fresh salts for each field - never entered by the owner.">
            <FormField label="Full name" htmlFor="owner-name">
              <Input
                id="owner-name"
                value={ownerIdentity.name}
                onChange={(e) => setOwnerIdentity((v) => ({...v, name: e.target.value}))}
              />
            </FormField>
            <FormField label="Country of identification" htmlFor="owner-country" helperText="ISO 3166-1 alpha-2, e.g. US">
              <Input
                id="owner-country"
                maxLength={2}
                value={ownerIdentity.countryOfIdentification}
                onChange={(e) => setOwnerIdentity((v) => ({...v, countryOfIdentification: e.target.value.toUpperCase()}))}
              />
            </FormField>
            <FormField label="Identification number" htmlFor="owner-id">
              <Input
                id="owner-id"
                value={ownerIdentity.identification}
                onChange={(e) => setOwnerIdentity((v) => ({...v, identification: e.target.value}))}
              />
            </FormField>
          </FormSection>

          <FormSection title="4. Pet profile">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Species" htmlFor="species">
                <Input id="species" value={profile.species} onChange={(e) => setProfile((v) => ({...v, species: e.target.value}))} />
              </FormField>
              <FormField label="Breed" htmlFor="breed">
                <Input id="breed" value={profile.breedLabel} onChange={(e) => setProfile((v) => ({...v, breedLabel: e.target.value}))} />
              </FormField>
              <FormField label="Sex" htmlFor="sex">
                <Select id="sex" value={profile.sex} onChange={(e) => setProfile((v) => ({...v, sex: e.target.value as PetSex}))}>
                  <option value="">Unknown</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </Select>
              </FormField>
              <FormField label="Neuter status" htmlFor="neuter">
                <Select
                  id="neuter"
                  value={profile.neuterStatus}
                  onChange={(e) => setProfile((v) => ({...v, neuterStatus: e.target.value as typeof profile.neuterStatus}))}
                >
                  <option value="">Unknown</option>
                  <option value="intact">Intact</option>
                  <option value="neutered">Neutered</option>
                  <option value="spayed">Spayed</option>
                </Select>
              </FormField>
              <FormField label="Date of birth" htmlFor="dob">
                <Input id="dob" type="date" value={profile.dateOfBirth} onChange={(e) => setProfile((v) => ({...v, dateOfBirth: e.target.value}))} />
              </FormField>
              <FormField label="Microchip code" htmlFor="microchip">
                <Input id="microchip" value={microchipCode} onChange={(e) => setMicrochipCode(e.target.value)} />
              </FormField>
            </div>
            <FormField label="Weight history" htmlFor="weights">
              <WeightHistoryEditor value={profile.weightHistory} onChange={(w) => setProfile((v) => ({...v, weightHistory: w}))} />
            </FormField>
          </FormSection>

          <div className="flex justify-end">
            <Button onClick={handleStart} disabled={starting || !ownerIdentity.name}>
              {starting ? "Starting..." : "Start issuance"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
