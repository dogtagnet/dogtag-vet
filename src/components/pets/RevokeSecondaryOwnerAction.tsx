"use client";

import {useEffect, useRef, useState} from "react";
import {useRouter} from "next/navigation";
import {useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {Button} from "@/components/ui/controls";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {useSnackbar} from "@/components/ui/Snackbar";
import {vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTxWithGas} from "@/lib/chainWrite";

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
export function RevokeSecondaryOwnerAction({petId, commitment, clientName}: {petId: string; commitment: string; clientName?: string}) {
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
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const receipt = useWaitForTransactionReceipt({hash: pendingTxHash, chainId: roax.id});

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = undefined;
  }
  useEffect(() => stopPolling, []);

  function startPolling(id: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/pets/${petId}/delegations/${id}`);
      if (!res.ok) return;
      const body = (await res.json()) as StaffStatus;
      setStatus(body);
      if (body.status === "confirmed") {
        stopPolling();
        snackbar.show("Secondary owner revoked", "ok");
        router.refresh();
      } else if (body.status === "error") {
        stopPolling();
      }
    }, 2000);
  }

  async function handleRevoke() {
    if (!address) return;
    setConfirming(false);
    setStarting(true);
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
      setRegistrationId(newRegistrationId);
      startPolling(newRegistrationId);

      const settingsRes = await fetch("/api/settings");
      const settings = settingsRes.ok ? await settingsRes.json() : null;
      if (!settings?.cloneAddress) {
        snackbar.show("This clinic has not completed setup", "danger");
        return;
      }
      // Need dogTagIdField to build the call - read it back off the pet the row already knows,
      // via the session the start call just created (the staff status poll's first tick carries
      // no dogTagIdField, so the wagmi call args come from the DEDICATED pet lookup instead).
      const petRes = await fetch(`/api/pets/${petId}`);
      const pet = petRes.ok ? await petRes.json() : null;
      const dogTagIdField: string | undefined = pet?.dogTag?.dogTagIdField;
      if (!dogTagIdField) {
        snackbar.show("Could not determine this tag's on-chain id", "danger");
        return;
      }

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
      snackbar.show(err instanceof Error ? err.message : "Transaction failed", "danger");
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (receipt.isSuccess && registrationId) {
      fetch(`/api/pets/${petId}/delegations/${registrationId}/confirm`, {method: "POST"})
        .then((r) => r.json())
        .then((body) => {
          if (body.status === "confirmed") {
            snackbar.show("Secondary owner revoked", "ok");
            router.refresh();
          }
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  if (registrationId) {
    if (status?.status === "error") {
      return <StatusBadge tone="danger" label={status.errorReason ?? "Revoke failed"} />;
    }
    return <StatusBadge tone="info" label="Revoking..." />;
  }

  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        Revoke
      </Button>
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
