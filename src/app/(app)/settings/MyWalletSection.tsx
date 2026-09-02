"use client";

import {useEffect, useState} from "react";
import {useRouter} from "next/navigation";
import {useAccount, useConnect} from "wagmi";
import {Button, Input} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {useSnackbar} from "@/components/ui/Snackbar";
import {operatorStatusBadge, operatorStatusExplanation, type OperatorStatus} from "@/lib/staffRoleTone";
import type {StaffDoc} from "@/lib/models/Staff";

/**
 * `/settings`'s WP4.7C item 2 self-service counterpart to `StaffSection`'s owner-only wallet field
 * (K2: "the vet can register their own... mobile address... or the owner can assign to them as
 * well" - that owner path is `StaffSection`'s existing "Practitioner profiles" panel and is
 * unchanged by this component). Rendered only for a vet/owner SESSION (see `settings/page.tsx`),
 * always scoped to the signed-in staff member's OWN row via `PATCH /api/settings/staff/me/wallet`
 * - there is no staffId picker here because this card can only ever touch one row.
 *
 * `status` (item 3, K2: "they can see that indeed the address is whitelisted... else show some
 * warning") is resolved SERVER-SIDE by `settings/page.tsx` (`resolveOperatorStatus`) and passed
 * down as a plain prop - unlike OperatorsSection's live client-side `useReadContract`, this card
 * never shows a "Checking..." transient: the answer is already settled by the time this component
 * mounts, and a save/clear's own `router.refresh()` (below) is what refreshes it afterward, the
 * same idiom every other mutation on this page already uses.
 */
export function MyWalletSection({initial, status}: {initial: StaffDoc; status: OperatorStatus}) {
  const snackbar = useSnackbar();
  const router = useRouter();
  const {address: connectedAddress, isConnected} = useAccount();
  const {connect, connectors, isPending: isConnecting} = useConnect();
  const [value, setValue] = useState(initial.walletAddress ?? "");
  const [busy, setBusy] = useState(false);

  // Same convention as StaffSection's DisplayNameField/WalletAddressField: resync the draft when
  // the server's own value changes underneath this component (a `router.refresh()` after this
  // card's own save, or an owner editing the same row from Practitioner profiles on this same
  // page load).
  useEffect(() => setValue(initial.walletAddress ?? ""), [initial.walletAddress]);

  async function save(next: string | null) {
    setBusy(true);
    try {
      const res = await fetch("/api/settings/staff/me/wallet", {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({walletAddress: next}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not update your wallet address.");
      snackbar.show(next ? "Wallet address saved" : "Wallet address cleared", "ok");
      // Same idiom as StaffSection/ServiceForm/PaymentForm's own mutations - the settings page's
      // OTHER server-rendered surfaces (this WP's item 3 status badge/banner, OperatorsSection's
      // roster) read this exact field server-side and have no other way to learn it changed.
      router.refresh();
    } catch (err) {
      setValue(initial.walletAddress ?? "");
      snackbar.show(err instanceof Error ? err.message : "Could not update your wallet address.", "danger");
    } finally {
      setBusy(false);
    }
  }

  const trimmed = value.trim();
  const dirty = trimmed !== (initial.walletAddress ?? "");

  return (
    <FormSection
      title="My issuance wallet"
      helperText="The wallet address you sign DogTag issuance transactions from. An owner can also set this for you in Practitioner profiles above."
    >
      <div className="flex items-center gap-2">
        <StatusBadge tone={operatorStatusBadge[status].tone} label={operatorStatusBadge[status].label} />
      </div>
      <p className="text-body text-ink-muted">{operatorStatusExplanation(status)}</p>
      <FormField
        label="Wallet address"
        htmlFor="my-wallet-address"
        helperText="0x... - the same address your connected wallet uses to sign issuance transactions."
      >
        <div className="flex items-center gap-2">
          <Input
            id="my-wallet-address"
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0x..."
            className="font-mono"
          />
          {isConnected ? (
            <Button
              variant="secondary"
              className="shrink-0"
              disabled={busy || !connectedAddress}
              onClick={() => connectedAddress && setValue(connectedAddress)}
            >
              Use connected wallet
            </Button>
          ) : (
            <Button
              variant="secondary"
              className="shrink-0"
              disabled={busy || isConnecting || connectors.length === 0}
              onClick={() => {
                const connector = connectors[0];
                if (connector) connect({connector});
              }}
            >
              {isConnecting ? "Connecting..." : "Connect wallet"}
            </Button>
          )}
        </div>
      </FormField>
      <div className="flex items-center gap-2">
        <Button disabled={busy || !dirty || trimmed === ""} onClick={() => save(trimmed)}>
          {busy ? "Saving..." : "Save"}
        </Button>
        <Button variant="secondary" disabled={busy || !initial.walletAddress} onClick={() => save(null)}>
          Clear
        </Button>
      </div>
    </FormSection>
  );
}
