"use client";

import {useEffect, useState} from "react";
import {useRouter} from "next/navigation";
import {DataTable} from "@/components/ui/DataTable";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {Button, Input, Select} from "@/components/ui/controls";
import {useSnackbar} from "@/components/ui/Snackbar";
import {hasExplicitName, isVetOrOwner, practitionerDisplayName, staffRoleLabel, staffRoleOptions} from "@/lib/staffRoleTone";
import type {StaffDoc, StaffRole} from "@/lib/models/Staff";

/**
 * WP4.13 - one text field bound to a single practitioner-profile string field (first name, last
 * name, title, or accreditation number), saving on blur only when the trimmed value actually
 * changed - same draft/blur-commit convention as WalletsPanel.tsx's WalletLabelField (its own doc
 * comment explains why this needs to be a dedicated component rather than an inline closure: it
 * holds draft text between keystrokes independently of the parent's committed state). Replaces
 * the single-field DisplayNameField this WP retires (`displayName` is now a deprecated fallback
 * tier, edited only via the "Clear legacy name" action below, never typed into directly). An
 * emptied field saves `null` (`Staff.setStaffProfile`'s `$unset` signal), not an empty string, so
 * clearing a name/title/accreditation number actually clears it - same rule WalletAddressField
 * below already follows.
 */
function ProfileTextField({
  id,
  value: storedValue,
  disabled,
  placeholder,
  onSave,
}: {
  id: string;
  value: string | undefined;
  disabled: boolean;
  placeholder?: string;
  onSave: (value: string | null) => void;
}) {
  const [value, setValue] = useState(storedValue ?? "");
  useEffect(() => setValue(storedValue ?? ""), [storedValue]);
  return (
    <Input
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed !== (storedValue ?? "")) onSave(trimmed === "" ? null : trimmed);
      }}
      placeholder={placeholder}
    />
  );
}

/** Same draft/blur-commit convention as ProfileTextField above (kept as its own component, not
 * folded into it, since it also carries the mono font styling an address needs). An emptied field
 * saves `null` (Staff.setStaffProfile's documented `$unset` signal), not an empty string, so
 * clearing a wallet actually clears it rather than storing "" as if it were a real (invalid)
 * address. */
function WalletAddressField({id, staff, disabled, onSave}: {id: string; staff: StaffDoc; disabled: boolean; onSave: (staffId: string, walletAddress: string | null) => void}) {
  const [value, setValue] = useState(staff.walletAddress ?? "");
  useEffect(() => setValue(staff.walletAddress ?? ""), [staff.walletAddress]);
  return (
    <Input
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const trimmed = value.trim();
        if (trimmed !== (staff.walletAddress ?? "")) onSave(staff.staffId, trimmed === "" ? null : trimmed);
      }}
      placeholder="0x..."
      className="font-mono"
    />
  );
}

/** `/settings`'s staff-access panel: the invite-only admin surface `auth.ts`'s sign-in gate
 * requires to be usable at all (wp4-vet.md's auth section: `owner|staff` roles) - an owner invites
 * an email here before that person can ever sign in through Google or a magic link. Role and
 * revoke controls only render for the CURRENT session's owner (`isOwner`); a non-owner still sees
 * the read-only roster so everyone can see who has access.
 *
 * WP4.7 A5 adds a second FormSection below the roster, "Practitioner profiles" - bookable/display
 * name/wallet are kept out of the roster DataTable itself (rather than three more columns) because
 * this page's containing div is `max-w-2xl`; a full wallet-address-width column there would either
 * force horizontal scrolling inside a page meant to read as a narrow settings form, or crush the
 * email/role columns to fit. A stacked per-practitioner block avoids both. */
export function StaffSection({initial, isOwner, currentStaffId}: {initial: StaffDoc[]; isOwner: boolean; currentStaffId?: string}) {
  const snackbar = useSnackbar();
  const router = useRouter();
  const [staff, setStaff] = useState(initial);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("staff");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const res = await fetch("/api/settings/staff");
    if (res.ok) setStaff(await res.json());
  }

  async function invite() {
    if (!email.trim()) {
      snackbar.show("Enter an email address to invite", "danger");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/settings/staff", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({email: email.trim(), role}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not invite this staff member.");
      snackbar.show(`Invited ${email.trim()} - they can now sign in.`, "ok");
      setEmail("");
      await refresh();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Could not invite this staff member.", "danger");
    } finally {
      setBusy(false);
    }
  }

  async function update(
    staffId: string,
    patch: {
      role?: StaffRole;
      disabled?: boolean;
      bookable?: boolean;
      displayName?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      title?: string | null;
      accreditationNumber?: string | null;
      walletAddress?: string | null;
    },
  ) {
    setBusy(true);
    // Optimistic update: every control bound to `staff` here (the role Select, the disable/restore
    // Buttons, and WP4.7 A5's new bookable checkbox) is controlled by this state, which otherwise
    // only ever changes once `refresh()` resolves - a controlled checkbox re-renders back to its
    // OLD `checked` value on every render until state actually changes, which without this looks
    // to the person clicking it like the click did nothing (caught by a Playwright `.check()`
    // failing with "did not change its state" while building A5's own visual check). Rolled back on
    // failure; reconciled with the server's authoritative shape either way via the `refresh()` below
    // (e.g. wouldRemoveActiveOwnerStatus side effects this optimistic patch doesn't know about).
    const previousStaff = staff;
    // StaffDoc models "unset" as the field being absent (`undefined`), never `null` - `null` is
    // only the WIRE signal telling the API to $unset it (Staff.setStaffProfile's own contract).
    // Built from ONLY the keys actually present in `patch` (checked via `"key" in patch`, not
    // `patch.key !== undefined`, since the value itself is legitimately undefined for a key that
    // IS present whenever a caller wants "leave unchanged" for the wire but that never happens
    // here - every call site below only ever includes the keys it means to change). A wider,
    // always-every-key object here (as this once did) silently reintroduces every OTHER field as
    // an explicit `undefined`, and `{...s, ...optimisticPatch}` overwrites `s`'s existing value the
    // moment a key is present at all - even when that key's value is `undefined` - so editing just
    // one field would visibly blank every other name/title/accreditation/wallet field on the row
    // until `refresh()` resolves.
    const optimisticPatch: Partial<StaffDoc> = {};
    if ("role" in patch) optimisticPatch.role = patch.role;
    if ("disabled" in patch) optimisticPatch.disabled = patch.disabled;
    if ("bookable" in patch) optimisticPatch.bookable = patch.bookable;
    if ("displayName" in patch) optimisticPatch.displayName = patch.displayName ?? undefined;
    if ("firstName" in patch) optimisticPatch.firstName = patch.firstName ?? undefined;
    if ("lastName" in patch) optimisticPatch.lastName = patch.lastName ?? undefined;
    if ("title" in patch) optimisticPatch.title = patch.title ?? undefined;
    if ("accreditationNumber" in patch) optimisticPatch.accreditationNumber = patch.accreditationNumber ?? undefined;
    if ("walletAddress" in patch) optimisticPatch.walletAddress = patch.walletAddress ?? undefined;
    setStaff((prev) => prev.map((s) => (s.staffId === staffId ? {...s, ...optimisticPatch} : s)));
    try {
      const res = await fetch(`/api/settings/staff/${staffId}`, {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not update this staff member.");
      await refresh();
      // WP4.7 A5 - role/bookable changes here feed BookingConfigSection's practitioner picker
      // (`listBookablePractitioners()`, fetched server-side once in page.tsx and passed down as a
      // plain prop) - a sibling client component with no way to learn about this change on its own.
      // router.refresh() re-runs the page's server components and streams fresh props to every
      // client component on it, same idiom as WalletsPanel.tsx/ServiceForm.tsx's own mutations.
      // The roster's OWN `refresh()` above stays too: `staff` is copied into local useState on
      // mount, so a new `initial` prop from router.refresh() alone would not, by itself, update it.
      router.refresh();
    } catch (err) {
      setStaff(previousStaff);
      snackbar.show(err instanceof Error ? err.message : "Could not update this staff member.", "danger");
    } finally {
      setBusy(false);
    }
  }

  const practitioners = staff.filter((s) => isVetOrOwner(s.role));

  return (
    <>
      <FormSection
        title="Staff access"
        helperText="Only an invited email can sign in with Google or a magic link. Invite a colleague before sharing this deployment's URL with them."
      >
        <DataTable
          columns={[
            // WP4.13 - blank rather than the email local part for a staff member nobody has ever
            // named: showing that guess here would just duplicate the adjacent Email column in a
            // slightly different format (see `hasExplicitName`'s own doc comment).
            {key: "name", header: "Name", render: (s: StaffDoc) => (hasExplicitName(s) ? practitionerDisplayName(s) : "")},
            {key: "email", header: "Email", render: (s: StaffDoc) => s.email},
            {key: "role", header: "Role", render: (s: StaffDoc) => staffRoleLabel[s.role]},
            {
              key: "status",
              header: "Status",
              render: (s: StaffDoc) => (s.disabled ? <StatusBadge tone="danger" label="Revoked" /> : <StatusBadge tone="ok" label="Active" />),
            },
            ...(isOwner
              ? [
                  {
                    key: "actions",
                    header: "",
                    render: (s: StaffDoc) =>
                      s.staffId === currentStaffId ? (
                        <span className="text-caption text-ink-faint">This is you</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          {/* WP4.7 A7 - plain className override (controls.tsx merges via cn()
                              now); no wrapper div needed. */}
                          <Select
                            value={s.role}
                            disabled={busy}
                            onChange={(e) => update(s.staffId, {role: e.target.value as StaffRole})}
                            aria-label={`Role for ${s.email}`}
                            className="w-28 shrink-0"
                          >
                            {staffRoleOptions.map((option) => (
                              <option key={option} value={option}>
                                {staffRoleLabel[option]}
                              </option>
                            ))}
                          </Select>
                          {s.disabled ? (
                            <Button variant="secondary" disabled={busy} onClick={() => update(s.staffId, {disabled: false})}>
                              Restore
                            </Button>
                          ) : (
                            <Button variant="danger" disabled={busy} onClick={() => update(s.staffId, {disabled: true})}>
                              Revoke
                            </Button>
                          )}
                        </div>
                      ),
                  },
                ]
              : []),
          ]}
          rows={staff}
          getRowKey={(s) => s.staffId}
          emptyMessage="No staff invited yet."
        />

        {isOwner && (
          // WP4.7 A7 - was two wrapper divs (Input/Select's base class is w-full, which plain
          // string concatenation could never override - the Select once grew to full width and
          // squeezed the email field to a sliver, Kenneth's 2026-09-01 report). controls.tsx now
          // merges className via tailwind-merge (cn()), and FormField now takes its own className
          // (for the SAME reason - sizing FormField's outer box within this row, not fighting an
          // Input's w-full), so neither wrapper is needed any more.
          <div className="mt-4 flex items-end gap-2">
            <FormField label="Invite by email" htmlFor="invite-email" className="min-w-0 flex-1">
              <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@clinic.example" />
            </FormField>
            <Select value={role} onChange={(e) => setRole(e.target.value as StaffRole)} aria-label="Role to invite as" className="w-32 shrink-0">
              {staffRoleOptions.map((option) => (
                <option key={option} value={option}>
                  {staffRoleLabel[option]}
                </option>
              ))}
            </Select>
            <Button className="shrink-0" onClick={invite} disabled={busy}>
              Invite
            </Button>
          </div>
        )}
      </FormSection>

      <FormSection
        title="Practitioner profiles"
        helperText="Vet and owner accounts can be marked bookable for the public booking page and per-practitioner scheduling, with a name and qualification shown to clients, a government accreditation number kept internal to this clinic, and the wallet used to sign DogTag issuance transactions."
      >
        <div className="space-y-4">
          {practitioners.map((s) => {
            // WP4.13 - a legacy displayName only still means something to show/clear once neither
            // half of the new first/last split has been entered; the moment either is set, tier 1
            // takes over (`practitionerDisplayName`'s own tier order) and the old value is inert.
            const tier1NameSet = Boolean(s.firstName?.trim() || s.lastName?.trim());
            const legacyDisplayName = tier1NameSet ? undefined : s.displayName?.trim();
            return (
              <div key={s.staffId} className="rounded-control border border-border p-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-body font-medium text-ink">{practitionerDisplayName(s)}</p>
                    <p className="truncate text-caption text-ink-faint">{s.email}</p>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-body text-ink">
                    <input
                      type="checkbox"
                      checked={s.bookable ?? false}
                      disabled={!isOwner || busy}
                      onChange={(e) => update(s.staffId, {bookable: e.target.checked})}
                    />
                    Bookable
                  </label>
                </div>
                {legacyDisplayName && (
                  <p className="mb-3 text-caption text-ink-faint">
                    Currently shown as &quot;{legacyDisplayName}&quot; (legacy display name). Enter a first and last name below to replace it.
                    {isOwner && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-2"
                        disabled={busy}
                        onClick={() => update(s.staffId, {displayName: null})}
                      >
                        Clear legacy name
                      </Button>
                    )}
                  </p>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FormField label="First name" htmlFor={`first-name-${s.staffId}`}>
                    <ProfileTextField
                      id={`first-name-${s.staffId}`}
                      value={s.firstName}
                      disabled={!isOwner || busy}
                      onSave={(firstName) => update(s.staffId, {firstName})}
                    />
                  </FormField>
                  <FormField label="Last name" htmlFor={`last-name-${s.staffId}`}>
                    <ProfileTextField
                      id={`last-name-${s.staffId}`}
                      value={s.lastName}
                      disabled={!isOwner || busy}
                      onSave={(lastName) => update(s.staffId, {lastName})}
                    />
                  </FormField>
                  <FormField
                    label="Title / qualification"
                    htmlFor={`title-${s.staffId}`}
                    helperText="Shown after the name, e.g. Jane Smith, DVM."
                  >
                    <ProfileTextField
                      id={`title-${s.staffId}`}
                      value={s.title}
                      placeholder="DVM"
                      disabled={!isOwner || busy}
                      onSave={(title) => update(s.staffId, {title})}
                    />
                  </FormField>
                  <FormField
                    label="Government accreditation number"
                    htmlFor={`accreditation-${s.staffId}`}
                    helperText="Internal only - never shown to clients or on the public booking page."
                  >
                    <ProfileTextField
                      id={`accreditation-${s.staffId}`}
                      value={s.accreditationNumber}
                      placeholder="USDA accreditation number"
                      disabled={!isOwner || busy}
                      onSave={(accreditationNumber) => update(s.staffId, {accreditationNumber})}
                    />
                  </FormField>
                  <FormField
                    label="Wallet address"
                    htmlFor={`wallet-${s.staffId}`}
                    helperText="The address that signs this practitioner's DogTag issuance transactions."
                    className="sm:col-span-2"
                  >
                    <WalletAddressField
                      id={`wallet-${s.staffId}`}
                      staff={s}
                      disabled={!isOwner || busy}
                      onSave={(staffId, walletAddress) => update(staffId, {walletAddress})}
                    />
                  </FormField>
                </div>
              </div>
            );
          })}
          {practitioners.length === 0 && (
            <p className="text-body text-ink-faint">No vet or owner accounts yet - invite one above, or change an existing staff member&apos;s role.</p>
          )}
        </div>
      </FormSection>
    </>
  );
}
