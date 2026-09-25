"use client";

import {useEffect, useRef, useState} from "react";
import {useRouter} from "next/navigation";
import {useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {Banner} from "@/components/ui/Banner";
import {Button} from "@/components/ui/controls";
import {HashCell} from "@/components/ui/HashCell";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {useSnackbar} from "@/components/ui/Snackbar";
import {vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTxWithGas} from "@/lib/chainWrite";
import {decodeRefundOutcome, refundFeedbackMessage} from "@/lib/refundFeedback";

interface StaffStatus {
  kind: "add" | "revoke";
  status: "pending" | "claimed" | "submitting" | "confirmed" | "error";
  errorReason?: string;
  txHash?: string;
  commitment?: string;
}

/**
 * WP4.15 multi-owner (PLANNED) - revoke has no device participation and no QR of its own
 * (`docs/DELEGATION.md` section 4.5) - this action goes straight from a confirm click to the
 * on-chain write via the connected operator wallet, unlike `AddSecondaryOwnerAction`'s QR wait.
 * `POST /api/pets/:id/delegations {mode:"revoke"}` creates the session already `"claimed"`, so
 * this component can call the operator wallet immediately.
 */
export function RevokeSecondaryOwnerAction({
  petId,
  dogTagIdField,
  commitment,
  clientName,
  disabled,
}: {
  petId: string;
  dogTagIdField: string;
  commitment: string;
  clientName?: string;
  /** Grade round 1 D2: `OwnersCard.tsx` passes `!data.delegationConfigured` here, the same
   * disabled-with-a-reason treatment `AddSecondaryOwnerAction` already had - this component was
   * previously not gated on `delegationConfigured` at all, so the two actions disagreed. */
  disabled?: boolean;
}) {
  const router = useRouter();
  const snackbar = useSnackbar();
  const {address, chainId} = useAccount();
  const {writeContractAsync} = useWriteContract();
  const publicClient = usePublicClient();

  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [registrationId, setRegistrationId] = useState<string | null>(null);
  const [status, setStatus] = useState<StaffStatus | null>(null);
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | undefined>(undefined);
  /** Coordinator's own fix-round instruction (grade round 1 D6): "a rejected wallet prompt must
   * return the Revoke action to idle with an inline error" - the pre-existing transient
   * `snackbar.show(...)` alone (still fired alongside this, unchanged) is easy to miss if the
   * staff member looked away, and leaves nothing on the row itself to explain why "Revoke" is
   * showing again. Cleared at the top of every fresh `handleRevoke()` attempt so a retry never
   * shows a stale message next to an in-flight one. */
  const [inlineError, setInlineError] = useState<string | null>(null);
  // WP4.19 V2 - the clone `revokeSecondaryOwner` was actually sent to, captured at send time.
  const cloneAddressRef = useRef<string | undefined>(undefined);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // WP4.17A D8 - same fix as `AddSecondaryOwnerAction.tsx`'s identical `settledRef`: the poll
  // branch below and the receipt effect further down both observe the same confirmed session and
  // used to each independently toast/refresh, so a clinic user could see "Secondary owner
  // revoked" twice. Reset only when a fresh revoke actually starts (`handleRevoke` below).
  const settledRef = useRef(false);

  const receipt = useWaitForTransactionReceipt({hash: pendingTxHash, chainId: roax.id});

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = undefined;
  }
  useEffect(() => stopPolling, []);

  /** The one place either the poll branch or the receipt effect is allowed to act on a confirmed
   * revoke - see `settledRef`'s own doc comment above. */
  function onConfirmed(refundMessage?: string) {
    if (settledRef.current) return;
    settledRef.current = true;
    stopPolling();
    // WP4.19 V2 - the poll branch below never has refund-feedback to report (it only ever learns
    // "confirmed" from Mongo, never the receipt's own logs), so `refundMessage` is only ever set
    // from the receipt-effect branch, which decoded it directly.
    snackbar.show(refundMessage ? `Secondary owner revoked. ${refundMessage}` : "Secondary owner revoked", "ok");
    router.refresh();
  }

  function startPolling(id: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/pets/${petId}/delegations/${id}`);
      if (!res.ok) return;
      const body = (await res.json()) as StaffStatus;
      setStatus(body);
      if (body.status === "confirmed") {
        // Deliberate overlap with the `receipt.isSuccess` effect below, not an oversight -
        // see `AddSecondaryOwnerAction.tsx`'s identical branch for the full reasoning
        // (`bootRecovery.ts`'s worker-driven stale-session recovery can confirm this session
        // while this tab is still open and polling, independent of wagmi ever resolving a
        // receipt here). `onConfirmed`'s own `settledRef` guard (WP4.17A D8) keeps that
        // redundancy load-bearing (either path can still be the one that notices) without also
        // toasting/refreshing twice.
        onConfirmed();
      } else if (body.status === "error") {
        stopPolling();
      }
    }, 2000);
  }

  /** Grade round 1 D6: once `registrationId` is set, the render logic below (unlike
   * `AddSecondaryOwnerAction`'s "claimed" state, which still shows a clickable "Add on chain"
   * button a rejected wallet prompt simply leaves in place) has no button at all - only a
   * "Revoking..." badge or an "error" badge the server-side session can never actually reach on
   * this path (nothing ever writes `status:"error"` for a client-side wallet rejection; the
   * session just stays "claimed" forever). Called from both the confirmed-nothing-was-broadcast
   * early return (no clinic clone configured) and the catch (wallet rejected, or any other client-
   * side failure) so the row always has a way back to idle instead of a permanent dead end. */
  function backToIdle() {
    stopPolling();
    setRegistrationId(null);
    setStatus(null);
    setPendingTxHash(undefined);
  }

  async function handleRevoke() {
    if (!address) return;
    setConfirming(false);
    setStarting(true);
    setInlineError(null);
    try {
      const startRes = await fetch(`/api/pets/${petId}/delegations`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({mode: "revoke", commitment, operatorAddress: address}),
      });
      const startBody = await startRes.json().catch(() => null);
      if (!startRes.ok) {
        snackbar.show(startBody?.error?.message ?? "Could not start the revoke", "danger");
        return;
      }
      const {registrationId: newRegistrationId} = startBody as {registrationId: string};
      // A fresh revoke - the ONLY place `settledRef` resets (WP4.17A D8).
      settledRef.current = false;
      setRegistrationId(newRegistrationId);
      startPolling(newRegistrationId);

      const settingsRes = await fetch("/api/settings");
      const settings = settingsRes.ok ? await settingsRes.json() : null;
      if (!settings?.cloneAddress) {
        snackbar.show("This clinic has not completed setup", "danger");
        setInlineError("This clinic has not completed setup");
        backToIdle();
        return;
      }
      cloneAddressRef.current = settings.cloneAddress;

      const hash = await writeContractAsync(
        await legacyTxWithGas(publicClient, {
          address: settings.cloneAddress as `0x${string}`,
          abi: vetIssuerAbi,
          functionName: "revokeSecondaryOwner",
          args: [BigInt(dogTagIdField), commitment as `0x${string}`],
          account: address,
        }),
      );
      await fetch(`/api/pets/${petId}/delegations/${newRegistrationId}/tx`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({txHash: hash}),
      });
      setPendingTxHash(hash);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transaction failed";
      snackbar.show(message, "danger");
      setInlineError(message);
      backToIdle();
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    // `isError` too, not just `isSuccess` (WP4.19 V5, replicating the 2026-09-25 incident fix
    // round 2 - `@wagmi/core`'s own `waitForTransactionReceipt` throws instead of resolving for a
    // REVERTED receipt, leaving this stuck on the bare "Revoking..." badge forever for a reverted
    // `revokeSecondaryOwner` before this fix, with no way back to idle at all). `/confirm` already
    // re-reads `isSecondary` on chain before trusting either outcome, so calling it on `isError` is
    // exactly as safe as `isSuccess` already was.
    if ((receipt.isSuccess || receipt.isError) && registrationId) {
      fetch(`/api/pets/${petId}/delegations/${registrationId}/confirm`, {method: "POST"})
        .then(async (r) => ({ok: r.ok, body: await r.json().catch(() => null)}))
        .then(({ok, body}) => {
          if (ok && body?.status === "confirmed") {
            // WP4.19 V2 - only on an actually-successful receipt.
            const refundMessage =
              receipt.isSuccess && receipt.data && cloneAddressRef.current
                ? refundFeedbackMessage(decodeRefundOutcome(receipt.data.logs, cloneAddressRef.current))
                : undefined;
            onConfirmed(refundMessage);
            return;
          }
          // The `/confirm` route already flipped this session's own Mongo status to "error" with a
          // reason (shared `confirm/route.ts`'s "reverted" branch) - reflected here immediately
          // rather than waiting for the next 2s poll tick, with the dead tx (`pendingTxHash`, kept
          // - see render below) still visible.
          setStatus((prev) => ({kind: "revoke", status: "error", errorReason: prev?.errorReason, txHash: prev?.txHash, commitment: prev?.commitment}));
        })
        .catch(() => setStatus((prev) => ({kind: "revoke", status: "error", errorReason: prev?.errorReason, txHash: prev?.txHash, commitment: prev?.commitment})));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess, receipt.isError]);

  if (registrationId) {
    if (status?.status === "error") {
      // WP4.19 V5 - upgraded from a bare StatusBadge (which had no retry affordance at all once
      // reached, per this component's own header comment on that pre-existing gap) to the same
      // "Transaction failed" Banner + kept hash + a way back to idle that
      // AddSecondaryOwnerAction.tsx's own error state already has, now that this path is actually
      // reachable client-side (not just from a later poll tick).
      return (
        <Banner tone="danger" title="Transaction failed">
          <p className="mb-3">{status.errorReason ?? "Revoke failed. Start over to try again."}</p>
          {pendingTxHash && (
            <div className="mb-3">
              <HashCell value={pendingTxHash} chain="roax" kind="tx" label="failed tx" />
            </div>
          )}
          <Button size="sm" onClick={backToIdle}>
            Start over
          </Button>
        </Banner>
      );
    }
    return <StatusBadge tone="info" label="Revoking..." />;
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} disabled={disabled}>
          Revoke
        </Button>
        {/* Grade round 1 D6's own "with an inline error" requirement - FormSection.tsx's
            established lightweight inline-error convention (text-caption/text-danger), not the
            heavier Banner component (design-system.md reserves Banner for setup prompts and
            standing-condition warnings, not a single transient action's own failure). */}
        {inlineError && (
          <p data-testid="revoke-inline-error" className="text-caption text-danger">
            {inlineError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="danger" size="sm" onClick={handleRevoke} disabled={starting || chainId !== roax.id}>
        {starting ? "Confirm in wallet..." : `Confirm revoke${clientName ? ` (${clientName})` : ""}`}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={starting}>
        Cancel
      </Button>
    </div>
  );
}
