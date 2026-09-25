"use client";

import {useEffect, useRef, useState} from "react";
import {useSearchParams} from "next/navigation";
import {useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {Banner} from "@/components/ui/Banner";
import {Button, Input, Select} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {QrSurface} from "@/components/ui/QrSurface";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {HashCell} from "@/components/ui/HashCell";
import {ClientPicker} from "@/components/pickers/ClientPicker";
import {WeightHistoryEditor} from "@/components/pets/WeightHistoryEditor";
import {useSnackbar} from "@/components/ui/Snackbar";
import {GasPreflightBanner} from "@/components/wallet/GasPreflightBanner";
import {vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTxWithGas} from "@/lib/chainWrite";
import {reasonCodeHash} from "@/lib/reasonCodes";
import {decodeRefundOutcome, refundFeedbackMessage, type RefundOutcome} from "@/lib/refundFeedback";
import {mintSessionStatusLabel, mintSessionStatusTone} from "@/lib/tagStatusTone";
import {useGasPreflight} from "@/lib/useGasPreflight";
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
  /** Set when a previous `issueTag` attempt confirmed REVERTED on chain (WP4.5 track 3) - shown
   * next to the re-enabled Issue button on a `ready` session. */
  lastIssueError?: string;
  /** The LAST reverted `issueTag` tx hash (2026-09-25 incident fix round 2) - kept for the record
   * (copyable, explorer link) next to the "Transaction failed" banner, unlike `txHash` (the
   * CURRENT live attempt only, cleared the instant a session reverts). */
  lastFailedTxHash?: string;
  errorStage?: string;
  errorReason?: string;
  /** Whether the C3 issuer attestation is already stored for this session's tag - read from the
   * linked Pet's own record (`GET .../route.ts`'s doc comment), never a client-local flag, so this
   * survives a reload instead of re-offering a signature that was already given and stored. */
  attestationSigned?: boolean;
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
  // WP4.12 (Kenneth issue 2) - three optional profile leaves.
  color: "",
  registrationId: "",
  registrationAuthority: "",
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
  const publicClient = usePublicClient();
  const {signTypedDataAsync} = useSignTypedData();
  const snackbar = useSnackbar();

  const [selectedClient, setSelectedClient] = useState<ClientDoc | null>(null);
  const [pets, setPets] = useState<PetDoc[]>([]);
  const [petId, setPetId] = useState<string>("");
  const [petName, setPetName] = useState("");
  const [ownerIdentity, setOwnerIdentity] = useState({name: "", countryOfIdentification: "", identification: ""});
  const [profile, setProfile] = useState(initialProfile);
  const [microchipCode, setMicrochipCode] = useState("");
  // zod's flatten() buckets every `profile.*` issue (mintProfileSchema is nested one level under
  // startMintSessionSchema) under the single top-level key "profile" - it cannot tell us WHICH
  // profile field failed, only that one did. Shown once for the whole "Pet profile" section rather
  // than pinned under a single input, which would be a false precision this API cannot back up.
  const [profileError, setProfileError] = useState<string | undefined>(undefined);

  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<SessionPoll | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>(undefined);
  // WP4.19 V2 - the clone `issueTag` was actually sent to, captured at send time (never re-fetched
  // from `/api/settings` a second time in the receipt effect below) so the refund-feedback decode
  // checks logs against the SAME address the write targeted.
  const issueCloneAddressRef = useRef<string | undefined>(undefined);
  const [issueRefundOutcome, setIssueRefundOutcome] = useState<RefundOutcome | null>(null);
  // WP4.19 V3 - shared by both writes this wizard can send (issueTag in the "ready" state,
  // revokeTag of the superseded tag in the "bound" replace-flow state below) - only one of the two
  // is ever visible/actionable at once, so one instance is enough.
  const gasPreflight = useGasPreflight();

  // The replace wizard (wp4-vet.md: "replace ... start new mint session for the same pet, and
  // after the new tag binds, prompt revoke of the old tag with REASON_REPLACED"). `replacingPet`
  // holds the pet's PRE-replace tag state (root/cloneAddress/dogTagIdField) so the post-bind
  // revoke prompt below can send `revokeTag` against the tag being replaced, not the new one.
  const [replacingPet, setReplacingPet] = useState<PetDoc | null>(null);
  const [revokingPrevious, setRevokingPrevious] = useState(false);
  const [revokePrevTxHash, setRevokePrevTxHash] = useState<`0x${string}` | undefined>(undefined);
  const [previousTagRevoked, setPreviousTagRevoked] = useState(false);
  // WP4.19 V2 - refund feedback for the replace-flow revoke of the SUPERSEDED tag (see
  // issueRefundOutcome's own comment above for the main issueTag write's identical purpose).
  const [revokePrevRefundOutcome, setRevokePrevRefundOutcome] = useState<RefundOutcome | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const receipt = useWaitForTransactionReceipt({hash: pendingTxHash, chainId: roax.id});
  const revokePrevReceipt = useWaitForTransactionReceipt({hash: revokePrevTxHash, chainId: roax.id});
  const searchParams = useSearchParams();
  const resumeSessionId = searchParams.get("session");
  const replacePetId = searchParams.get("replace");

  useEffect(() => {
    if (!selectedClient) {
      setPets([]);
      return;
    }
    // WP4.4 Q3: `dogTag.external: true` pets (a provisional record imported from a mobile
    // booking's foreign-tag claim - section 3, tier 4) are excluded from this clinic's own
    // tags/issuance surfaces - this clinic never issued that tag and has no authority over it, so
    // it must never appear as an "issue a tag for this pet" candidate here.
    fetch(`/api/pets?ownerClientId=${selectedClient.clientId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((fetchedPets: PetDoc[]) => setPets(fetchedPets.filter((pet) => !pet.dogTag?.external)));
  }, [selectedClient]);

  // WP4.12 (Kenneth issue 2): prefill color/registrationId/registrationAuthority from the selected
  // EXISTING pet's own CRM record - staff still enters the rest of the profile fresh for every
  // mint, exactly as before this wave (species/breed/sex/etc. are deliberately NOT prefilled here,
  // matching this wizard's existing behavior for every other field). Resets to the newly selected
  // pet's own values (falling back to "") rather than merging with whatever was already typed, so
  // switching from one existing pet to another never leaves the previous pet's data behind. A "New
  // pet" selection (`petId` empty) leaves whatever staff already typed untouched.
  useEffect(() => {
    if (!petId) return;
    const selected = pets.find((p) => p.petId === petId);
    if (!selected) return;
    setProfile((v) => ({
      ...v,
      color: selected.color ?? "",
      registrationId: selected.registrationId ?? "",
      registrationAuthority: selected.registrationAuthority ?? "",
    }));
  }, [petId, pets]);

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
    // Confirmed against the SUPERSEDED tag's own identity (`replacingPet.dogTag`, captured before
    // this replace flow began), never by re-reading `Pet.dogTag` for this petId - `POST
    // /api/tags/issue/:sessionId/confirm` has by now already overwritten that same field with the
    // NEW tag's id/root (see `revoke-superseded/route.ts`'s doc comment for why a petId-keyed
    // lookup here would read back the wrong tag and wrongly refuse to confirm).
    //
    // `isError` too, not just `isSuccess` (2026-09-25 incident fix round 2): wagmi's own
    // `waitForTransactionReceipt` (`@wagmi/core`, wrapped by `useWaitForTransactionReceipt`) does
    // NOT resolve normally for a REVERTED receipt the way viem's bare action does - it replays the
    // call via `eth_call` to extract a revert reason and THROWS, so this query's `isSuccess` would
    // never become true for a reverted `revokeTag`, leaving the "Revoke previous tag" prompt
    // waiting forever with no feedback. `revoke-superseded/route.ts` already re-reads
    // `isValid(root)` on the chain itself before trusting either outcome (its own `.catch` below
    // already handles that route refusing), so it is safe to call it either way and let the
    // server's own chain read decide.
    if (
      (revokePrevReceipt.isSuccess || revokePrevReceipt.isError) &&
      revokePrevTxHash &&
      replacingPet?.dogTag.cloneAddress &&
      replacingPet.dogTag.dogTagIdField &&
      replacingPet.dogTag.root
    ) {
      fetch("/api/tags/revoke-superseded", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          cloneAddress: replacingPet.dogTag.cloneAddress,
          dogTagIdField: replacingPet.dogTag.dogTagIdField,
          root: replacingPet.dogTag.root,
          reasonCode: "REASON_REPLACED",
          txHash: revokePrevTxHash,
        }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then(() => {
          snackbar.show("Previous tag revoked", "ok");
          setPreviousTagRevoked(true);
          // WP4.19 V2 - only on an actually-successful receipt (never on isError - a reverted
          // write refunds nothing and `revoke-superseded`'s own re-check above would already have
          // rejected the promise chain before this line for that case anyway).
          if (revokePrevReceipt.isSuccess && revokePrevReceipt.data && replacingPet.dogTag.cloneAddress) {
            setRevokePrevRefundOutcome(decodeRefundOutcome(revokePrevReceipt.data.logs, replacingPet.dogTag.cloneAddress));
          }
        })
        .catch(() => snackbar.show("Revoke transaction sent, but confirmation failed. Refresh and retry.", "danger"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revokePrevReceipt.isSuccess, revokePrevReceipt.isError]);

  async function handleRevokePrevious() {
    if (!replacingPet?.dogTag.cloneAddress || !replacingPet.dogTag.dogTagIdField || !address) return;
    // WP4.19 V3 - refuse to send when the wallet cannot even cover this revoke's own gas floor at
    // the current gas price; the banner (rendered below, next to this button) explains why and
    // offers a top-up request.
    if (!(await gasPreflight.ensure(publicClient, address, "revokeTag"))) return;
    setRevokingPrevious(true);
    try {
      const hash = await writeContractAsync(
        await legacyTxWithGas(publicClient, {
          address: replacingPet.dogTag.cloneAddress as `0x${string}`,
          abi: vetIssuerAbi,
          functionName: "revokeTag",
          args: [BigInt(replacingPet.dogTag.dogTagIdField), reasonCodeHash("REASON_REPLACED")],
          account: address,
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
    setProfileError(undefined);
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
        // zod's flatten() keys nested `profile.*` errors under "profile" (an array of every
        // message for that whole sub-object, not per-field - see profileError's own comment).
        const profileFieldErrors = body?.error?.details?.fieldErrors?.profile as string[] | undefined;
        if (profileFieldErrors?.length) setProfileError(profileFieldErrors.join(" "));
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
      // WP4.19 V3 - refuse to send when the wallet cannot even cover issueTag's own gas floor at
      // the current gas price; the banner below the Issue button explains why and offers a top-up
      // request, and this returns before ever calling writeContractAsync.
      if (!(await gasPreflight.ensure(publicClient, address, "issueTag"))) return;
      issueCloneAddressRef.current = settings.cloneAddress;
      setIssueRefundOutcome(null);
      const hash = await writeContractAsync(
        // Headroom over the bare estimate - the refund tail starved twice at the wallet's own
        // estimate (see legacyTxWithGas's doc comment for the incident txs).
        await legacyTxWithGas(publicClient, {
          address: settings.cloneAddress as `0x${string}`,
          abi: vetIssuerAbi,
          functionName: "issueTag",
          args: [BigInt(session.dogTagIdField), session.root as `0x${string}`],
          account: address,
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
    // `isError` too, not just `isSuccess` (2026-09-25 incident fix round 2 - the actual root cause
    // of the session getting stuck on "Issuing" / "Waiting for the transaction to confirm..."
    // forever after a reverted `issueTag`): wagmi's own `waitForTransactionReceipt`
    // (`@wagmi/core`, what `useWaitForTransactionReceipt` calls under the hood) does NOT resolve
    // normally for a REVERTED receipt the way viem's bare `waitForTransactionReceipt` action does -
    // it replays the call via `eth_call` to extract a revert reason and THROWS instead, so
    // `receipt.isSuccess` never becomes `true` for a reverted tx and this effect, gated on
    // `isSuccess` alone, never ran. The confirm route re-reads the receipt status itself via a raw
    // JSON-RPC call (`readTxReceiptStatus`, independent of wagmi's own client-side interpretation)
    // and is the sole source of truth either way ("a receipt is not proof") - calling it on
    // `isError` is exactly as safe as calling it on `isSuccess` already was.
    if ((receipt.isSuccess || receipt.isError) && session?.sessionId) {
      // WP4.19 V2 - only from an actually-successful receipt: a reverted issueTag refunds nothing
      // (the clone's own `refundsGas` modifier never even reaches its refund step when the wrapped
      // call itself reverted), so there is nothing meaningful to decode on the isError path.
      if (receipt.isSuccess && receipt.data && issueCloneAddressRef.current) {
        setIssueRefundOutcome(decodeRefundOutcome(receipt.data.logs, issueCloneAddressRef.current));
      }
      fetch(`/api/tags/issue/${session.sessionId}/confirm`, {method: "POST"})
        .then((r) => r.json())
        .then((body) => {
          if (body.status === "bound") snackbar.show("Tag bound on chain", "ok");
          // WP4.5 track 3: a reverted `issueTag` lands back on `ready` (not `error`) with
          // `lastIssueError` set - shown immediately here (not left to wait for the next 2s poll
          // tick) and the now-dead `txHash` cleared, matching what the next GET poll will confirm.
          // `lastFailedTxHash` (2026-09-25 fix round 2) is the one the "Transaction failed" banner
          // below renders - kept for the record even though the live `txHash` is cleared. A bare
          // `body.status ?? prev.status` (every other outcome) deliberately leaves
          // `txHash`/`lastIssueError` untouched - `JSON.stringify` drops an explicit `undefined`
          // key entirely, so those OTHER response shapes (202 chain-read-failed passthrough, the
          // plain `{error}` badRequest body) never actually carry these fields to distinguish
          // "clear it" from "this response just doesn't mention it".
          if (body.status === "ready") {
            if (body.lastIssueError) snackbar.show(body.lastIssueError, "danger");
            setSession((prev) =>
              prev
                ? {...prev, status: "ready", txHash: undefined, lastIssueError: body.lastIssueError, lastFailedTxHash: body.lastFailedTxHash}
                : prev,
            );
          } else {
            setSession((prev) => (prev ? {...prev, status: body.status ?? prev.status} : prev));
          }
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, receipt.isError]);

  async function handleSignAttestation() {
    if (!session?.sessionId || !address) return;
    const payloadRes = await fetch(`/api/tags/issue/${session.sessionId}/attestation`);
    const payload = await payloadRes.json().catch(() => null);
    if (!payloadRes.ok) {
      snackbar.show(payload?.error?.message ?? "Could not build the attestation payload", "danger");
      return;
    }
    try {
      const signature = await signTypedDataAsync({
        domain: payload.domain,
        types: payload.types,
        primaryType: "IssuerAttestation",
        message: payload.message,
      });
      const storeRes = await fetch(`/api/tags/issue/${session.sessionId}/attestation`, {
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
      // Reload-survival (WP4.5 track 3): the done-badge state is derived from the poll payload's
      // `attestationSigned` (itself read off the linked Pet's `dogTag.attestation`, the same field
      // this POST just wrote), never a client-local flag - so a reload keeps showing the badge
      // instead of re-offering a signature that was already given and stored. Setting it directly
      // here too just avoids waiting for the next 2s poll tick for the SAME tab's own UI to update.
      setSession((prev) => (prev ? {...prev, attestationSigned: true} : prev));
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
    if (body.status === "bound") {
      // The session had actually anchored on chain already (e.g. a worker restart marked it
      // `error` without that ever being true) - the retry route reconciled it straight to `bound`
      // instead of manufacturing a token that could never seal. Reflect that immediately rather
      // than pretending a fresh mint round just started.
      stopPolling();
      setSession((prev) =>
        prev ? {...prev, status: "bound", dogTagId: body.dogTagId ?? prev.dogTagId, root: body.root ?? prev.root} : prev,
      );
      snackbar.show("This tag was already issued on chain - marked bound.", "ok");
      return;
    }
    if (body.status === "ready") {
      // The session's error was actually a confirmed-REVERTED `issueTag` (WP4.5 track 3) - the
      // retry route reconciled it straight back to `ready` on the SAME session/root, exactly like
      // the confirm route's own reverted branch, rather than arming a brand new bind token (which
      // would needlessly discard an already-bound profile tree and send the owner through the QR
      // ceremony again for no reason).
      stopPolling();
      setSession((prev) =>
        prev
          ? {
              ...prev,
              status: "ready",
              dogTagId: body.dogTagId ?? prev.dogTagId,
              root: body.root ?? prev.root,
              txHash: undefined,
              lastIssueError: body.lastIssueError,
              lastFailedTxHash: body.lastFailedTxHash,
            }
          : prev,
      );
      if (body.lastIssueError) snackbar.show(body.lastIssueError, "danger");
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
            <StatusBadge tone={mintSessionStatusTone[session.status]} label={mintSessionStatusLabel[session.status]} />
            {session.root && <HashCell value={session.root} kind="root" label="root" />}
            {session.txHash && <HashCell value={session.txHash} chain="roax" kind="tx" label="tx" />}
          </div>

          {session.status === "pending" && session.qr && (
            <div className="mt-4 flex justify-center">
              <QrSurface data={session.qr} caption="Scan with the owner's DogTag app" expiresAt={Math.floor(Date.now() / 1000) + (session.ttlSecs ?? 0)} />
            </div>
          )}

          {session.status === "ready" && (
            <div className="mt-4 space-y-3">
              {session.lastIssueError && (
                // Kenneth, 2026-09-25 incident fix round 2: an explicit "Transaction failed" state
                // (not the earlier "Previous attempt did not confirm" wording) with the dead tx kept
                // for the record - copyable, explorer-linked, via the same HashCell every other tx
                // hash in this wizard renders through - rather than silently dropped once the
                // session (correctly) returns to `ready` so staff can retry. The session itself is
                // NEVER lost: same sessionId/root, "Issue on chain" below is the retry action.
                <Banner tone="danger" title="Transaction failed">
                  <p>{session.lastIssueError}</p>
                  {session.lastFailedTxHash && (
                    <div className="mt-2">
                      <HashCell value={session.lastFailedTxHash} chain="roax" kind="tx" label="failed tx" />
                    </div>
                  )}
                </Banner>
              )}
              <p className="text-body text-ink-muted">
                The device built and bound its profile tree. Issue this tag on chain from your operator wallet.
              </p>
              <p className="text-caption text-ink-faint">
                Gas is fronted by your wallet and refunded by the clinic&apos;s clone on success (failed attempts are
                not refunded).
              </p>
              <Button onClick={handleIssue} disabled={issuing}>
                {issuing ? "Issuing..." : "Issue on chain"}
              </Button>
              {gasPreflight.block && <GasPreflightBanner message={gasPreflight.block.message} walletAddress={address} />}
            </div>
          )}

          {session.status === "issuing" && (
            <p className="mt-4 text-body text-ink-muted">Waiting for the transaction to confirm...</p>
          )}

          {session.status === "bound" && (
            <div className="mt-4 space-y-4">
              <p className="text-body text-ok">Tag bound successfully.</p>
              {/* WP4.19 V2 - whether the clinic's clone refunded the gas this wallet fronted for
                  issueTag, decoded from the mined receipt's own logs (never a guess). */}
              {issueRefundOutcome && <p className="text-caption text-ink-muted">{refundFeedbackMessage(issueRefundOutcome)}</p>}
              {session.attestationSigned ? (
                <StatusBadge label="Issuer attestation signed" tone="ok" />
              ) : (
                <Button onClick={handleSignAttestation}>Sign issuer attestation</Button>
              )}
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
                  {gasPreflight.block && (
                    <div className="mt-3">
                      <GasPreflightBanner message={gasPreflight.block.message} walletAddress={address} />
                    </div>
                  )}
                </Banner>
              )}
              {previousTagRevoked && (
                <div className="space-y-1">
                  <p className="text-body text-ok">Previous tag revoked.</p>
                  {revokePrevRefundOutcome && <p className="text-caption text-ink-muted">{refundFeedbackMessage(revokePrevRefundOutcome)}</p>}
                </div>
              )}
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
        <ClientPicker value={selectedClient} onChange={setSelectedClient} placeholder="Search clients" />
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
          {petId && pets.find((p) => p.petId === petId)?.dogTag?.status === "active" && (
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
            {profileError && <p className="text-caption text-danger">{profileError}</p>}
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
              <FormField label="Color" htmlFor="color" className="min-w-0">
                <Input
                  id="color"
                  maxLength={120}
                  placeholder="brown"
                  value={profile.color}
                  onChange={(e) => setProfile((v) => ({...v, color: e.target.value}))}
                />
              </FormField>
              <FormField label="Government registration id" htmlFor="registration-id" className="min-w-0">
                <Input
                  id="registration-id"
                  maxLength={120}
                  placeholder="e.g. AVS licence number"
                  value={profile.registrationId}
                  onChange={(e) => setProfile((v) => ({...v, registrationId: e.target.value}))}
                />
              </FormField>
              <FormField label="Registration authority" htmlFor="registration-authority" className="min-w-0">
                <Input
                  id="registration-authority"
                  maxLength={120}
                  placeholder="e.g. AVS Singapore"
                  value={profile.registrationAuthority}
                  onChange={(e) => setProfile((v) => ({...v, registrationAuthority: e.target.value}))}
                />
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
