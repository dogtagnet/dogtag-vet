"use client";

import {useReadContract} from "wagmi";
import {AddressChip} from "@/components/ui/AddressChip";
import {FormSection} from "@/components/ui/FormSection";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {vetIssuerAbi} from "@/lib/abi";
import {isVetOrOwner, operatorStatusBadge, practitionerDisplayName} from "@/lib/staffRoleTone";
import type {StaffDoc} from "@/lib/models/Staff";

/**
 * One vet/owner staff row that has recorded a wallet: a live, READ-ONLY `operators(address)` read
 * against this clinic's clone. A dedicated component - not inlined in the parent's `.map()` -
 * because each row needs its own `useReadContract` hook instance scoped to its own wallet address,
 * the same reason StaffSection.tsx's DisplayNameField/WalletAddressField are dedicated components
 * rather than inline closures.
 *
 * WP4.16 removed this row's own Add/Remove write entirely: `VetIssuer.addOperator`/
 * `removeOperator` are `onlyFactoryAdmin` on the actual contract, so the owner-signed write this
 * row used to submit always reverted on a real chain - only the e2e stub (which never executes a
 * real EVM) ever let it appear to work. See `wp4.16-operator-whitelisting.md` and
 * `docs/DEPLOY.md`'s "Vet role, issuance operators, and per-practitioner scheduling" section for
 * the real procedure (apply in the DogTag admin portal, the admin approves). This row is now a
 * pure, honest status display: the read needs no wallet connected at all (`operators` is a public
 * view function, answered by the public client), so anyone looking at this panel can always see
 * who currently holds on-chain operator status.
 */
function OperatorRow({staff, cloneAddress}: {staff: StaffDoc; cloneAddress: `0x${string}`}) {
  const wallet = staff.walletAddress as `0x${string}`;

  const operatorStatus = useReadContract({
    address: cloneAddress,
    abi: vetIssuerAbi,
    functionName: "operators",
    args: [wallet],
  });
  const isActive = operatorStatus.data === true;

  return (
    <div className="flex items-center justify-between gap-2 rounded-control border border-border p-3">
      <div className="min-w-0">
        <p className="truncate text-body font-medium text-ink">{practitionerDisplayName(staff)}</p>
        <AddressChip address={wallet} chain="roax" />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {operatorStatus.isLoading ? (
          <StatusBadge tone="neutral" label="Checking..." />
        ) : operatorStatus.isError ? (
          // WP4.7C item 3(c) - the one gap this read had no representation for at all: an
          // unreadable chain silently fell through to "Inactive" (a false negative - the design
          // intent's "chain-unreadable is its own honest state" applies here too), never
          // triggered by the e2e stub so never caught before. `operatorStatusBadge` is the SAME
          // shared vocabulary the new "My issuance wallet" card/banner use, imported here for
          // this one state only - "Active"/"Inactive" below are untouched, byte-identical to
          // before this item (asserted verbatim by e2e/practitioner-mode.spec.ts).
          <StatusBadge tone={operatorStatusBadge.unreadable.tone} label={operatorStatusBadge.unreadable.label} />
        ) : isActive ? (
          <StatusBadge tone="ok" label="Active" />
        ) : (
          <StatusBadge tone="neutral" label="Inactive" />
        )}
      </div>
    </div>
  );
}

/**
 * `/settings`'s D4 "Issuance operators" panel - owner-only. Lists every vet/owner staff row that
 * has recorded a wallet (`StaffSection`'s "Practitioner profiles" above is where that wallet gets
 * set - this panel only ever reads it, never edits it), with a live on-chain `operators(address)`
 * status per row.
 *
 * WP4.16 (Kenneth: "only the protocol admin key may change that list"): this panel used to also
 * offer an owner-signed Add/Remove write here, but `VetIssuer.addOperator`/`removeOperator` are
 * `onlyFactoryAdmin` - that write always reverted on a real chain no matter which wallet was
 * connected, and only the e2e stub's never-executes-a-real-EVM behavior ever masked that. The
 * whitelist is now changed exclusively by the DogTag protocol admin, applied for by this clinic in
 * the DogTag admin portal and approved there (`wp4.16-operator-whitelisting.md`) - this panel is
 * purely informational, the same read this app has always trusted as the actual source of truth.
 * This app's own `requireVetSession` (staffApi.ts) still gates the issuance APIs/pages by
 * app-side role, independent of on-chain operator status, exactly like every other role check in
 * this WP.
 */
export function OperatorsSection({staff, cloneAddress, isOwner}: {staff: StaffDoc[]; cloneAddress?: string; isOwner: boolean}) {
  if (!isOwner) return null;

  const operators = staff.filter((s) => isVetOrOwner(s.role) && s.walletAddress);

  return (
    <FormSection
      title="Issuance operators"
      helperText="Only the DogTag protocol admin can grant or revoke issuance rights. Apply for this practitioner in the DogTag admin portal (Issuance operators on your clinic's status page). A vet or owner needs BOTH a recorded wallet (Practitioner profiles above) and Active status here before they can sign issuance transactions."
    >
      {!cloneAddress ? (
        <p className="text-body text-ink-faint">Run the setup wizard first to discover this clinic&apos;s clone address.</p>
      ) : operators.length === 0 ? (
        <p className="text-body text-ink-faint">No vet or owner staff have recorded a wallet address yet - set one in Practitioner profiles above.</p>
      ) : (
        <div className="space-y-2">
          {operators.map((s) => (
            <OperatorRow key={s.staffId} staff={s} cloneAddress={cloneAddress as `0x${string}`} />
          ))}
        </div>
      )}
    </FormSection>
  );
}
