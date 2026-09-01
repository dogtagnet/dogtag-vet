"use client";

import {useEffect, useState} from "react";
import {useAccount, useConnect, usePublicClient, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {AddressChip} from "@/components/ui/AddressChip";
import {Banner} from "@/components/ui/Banner";
import {Button} from "@/components/ui/controls";
import {FormSection} from "@/components/ui/FormSection";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {useSnackbar} from "@/components/ui/Snackbar";
import {vetIssuerAbi} from "@/lib/abi";
import {roax} from "@/lib/chains";
import {legacyTxWithGas} from "@/lib/chainWrite";
import {isVetOrOwner, practitionerDisplayName} from "@/lib/staffRoleTone";
import type {StaffDoc} from "@/lib/models/Staff";

/**
 * One vet/owner staff row that has recorded a wallet: a live `operators(address)` read against
 * this clinic's clone, plus an owner-only Add/Remove button using the OWNER'S connected wallet
 * (D4). A dedicated component - not inlined in the parent's `.map()` - because each row needs its
 * own `useReadContract`/`useWriteContract`/`useWaitForTransactionReceipt` hook instances scoped to
 * its own wallet address, the same reason StaffSection.tsx's DisplayNameField/WalletAddressField
 * are dedicated components rather than inline closures.
 *
 * The read works with no wallet connected at all (`operators` is a public view function, answered
 * by the public client) - only the Add/Remove WRITE needs `canWrite` (connected, correct chain,
 * owner). This is deliberate: anyone looking at this panel can always see who currently holds
 * on-chain operator status, even before connecting a wallet themselves.
 */
function OperatorRow({staff, cloneAddress, canWrite, connectedAddress}: {staff: StaffDoc; cloneAddress: `0x${string}`; canWrite: boolean; connectedAddress?: `0x${string}`}) {
  const snackbar = useSnackbar();
  const publicClient = usePublicClient();
  const {writeContractAsync} = useWriteContract();
  const wallet = staff.walletAddress as `0x${string}`;
  const [busy, setBusy] = useState(false);
  const [pendingHash, setPendingHash] = useState<`0x${string}` | undefined>(undefined);
  const [pendingAction, setPendingAction] = useState<"add" | "remove" | null>(null);

  const operatorStatus = useReadContract({
    address: cloneAddress,
    abi: vetIssuerAbi,
    functionName: "operators",
    args: [wallet],
  });
  const isActive = operatorStatus.data === true;

  const receipt = useWaitForTransactionReceipt({hash: pendingHash, chainId: roax.id});

  useEffect(() => {
    if (!receipt.isSuccess || !pendingHash) return;
    const name = practitionerDisplayName(staff);
    snackbar.show(pendingAction === "add" ? `${name} is now an active operator` : `${name} is no longer an operator`, "ok");
    setPendingHash(undefined);
    setPendingAction(null);
    operatorStatus.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  async function toggle() {
    if (!connectedAddress || !canWrite) return;
    const action: "add" | "remove" = isActive ? "remove" : "add";
    setBusy(true);
    try {
      const hash = await writeContractAsync(
        // Headroom over the bare estimate - see legacyTxWithGas's doc comment for the incident
        // txs the refund tail starved at the wallet's own estimate.
        await legacyTxWithGas(publicClient, {
          address: cloneAddress,
          abi: vetIssuerAbi,
          functionName: action === "add" ? "addOperator" : "removeOperator",
          args: [wallet],
          account: connectedAddress,
        }),
      );
      setPendingHash(hash);
      setPendingAction(action);
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Transaction failed", "danger");
    } finally {
      setBusy(false);
    }
  }

  const confirming = busy || Boolean(pendingHash);

  return (
    <div className="flex items-center justify-between gap-2 rounded-control border border-border p-3">
      <div className="min-w-0">
        <p className="truncate text-body font-medium text-ink">{practitionerDisplayName(staff)}</p>
        <AddressChip address={wallet} chain="roax" />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {operatorStatus.isLoading ? (
          <StatusBadge tone="neutral" label="Checking..." />
        ) : isActive ? (
          <StatusBadge tone="ok" label="Active" />
        ) : (
          <StatusBadge tone="neutral" label="Inactive" />
        )}
        <Button variant={isActive ? "danger" : "secondary"} disabled={!canWrite || confirming} onClick={toggle}>
          {confirming ? "Confirming..." : isActive ? "Remove operator" : "Add operator"}
        </Button>
      </div>
    </div>
  );
}

/**
 * `/settings`'s D4 "Issuance operators" panel - owner-only (D4: "Settings gains an 'Issuance
 * operators' panel (owner-only)"). Lists every vet/owner staff row that has recorded a wallet
 * (`StaffSection`'s "Practitioner profiles" above is where that wallet gets set - this panel
 * reads it, never edits it), with live on-chain `operators(address)` status and Add/Remove via the
 * OWNER's own connected wallet - the same wagmi write path (`legacyTxWithGas`) issuance itself
 * uses (`TagIssueWizard`/`TagsTable`). The chain stays the final authority either way: this app's
 * own `requireVetSession` (staffApi.ts) gates the issuance APIs/pages by role, independent of
 * on-chain operator status, exactly like every other role check in this WP.
 */
export function OperatorsSection({staff, cloneAddress, isOwner}: {staff: StaffDoc[]; cloneAddress?: string; isOwner: boolean}) {
  const {address, isConnected, chainId} = useAccount();
  const {connect, connectors, isPending: isConnecting} = useConnect();
  const {switchChain} = useSwitchChain();

  if (!isOwner) return null;

  const wrongNetwork = isConnected && chainId !== roax.id;
  const canWrite = isConnected && !wrongNetwork;
  const operators = staff.filter((s) => isVetOrOwner(s.role) && s.walletAddress);

  return (
    <FormSection
      title="Issuance operators"
      helperText="Grant or revoke on-chain permission to issue and revoke DogTags on this clinic's clone. A vet or owner needs BOTH a recorded wallet (Practitioner profiles above) and Active status here before they can sign issuance transactions."
    >
      {!cloneAddress ? (
        <p className="text-body text-ink-faint">Run the setup wizard first to discover this clinic&apos;s clone address.</p>
      ) : operators.length === 0 ? (
        <p className="text-body text-ink-faint">No vet or owner staff have recorded a wallet address yet - set one in Practitioner profiles above.</p>
      ) : (
        <div className="space-y-3">
          {!isConnected && (
            <div className="flex items-center gap-3">
              <p className="text-body text-ink-muted">Connect the wallet you use to operate this clinic&apos;s clone to add or remove operators.</p>
              <Button
                variant="secondary"
                className="shrink-0"
                disabled={isConnecting || connectors.length === 0}
                onClick={() => {
                  const connector = connectors[0];
                  if (connector) connect({connector});
                }}
              >
                {isConnecting ? "Connecting..." : "Connect wallet"}
              </Button>
            </div>
          )}
          {isConnected && wrongNetwork && (
            <Banner tone="warn" title="Wrong network">
              Switch your wallet to ROAX (chain {roax.id}) to add or remove operators.
              <div className="mt-2">
                <Button variant="secondary" onClick={() => switchChain({chainId: roax.id})}>
                  Switch network
                </Button>
              </div>
            </Banner>
          )}
          <div className="space-y-2">
            {operators.map((s) => (
              <OperatorRow key={s.staffId} staff={s} cloneAddress={cloneAddress as `0x${string}`} canWrite={canWrite} connectedAddress={address} />
            ))}
          </div>
        </div>
      )}
    </FormSection>
  );
}
