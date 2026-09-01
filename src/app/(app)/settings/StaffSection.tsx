"use client";

import {useState} from "react";
import {DataTable} from "@/components/ui/DataTable";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {Button, Input, Select} from "@/components/ui/controls";
import {useSnackbar} from "@/components/ui/Snackbar";
import {staffRoleLabel, staffRoleOptions} from "@/lib/staffRoleTone";
import type {StaffDoc, StaffRole} from "@/lib/models/Staff";

/** `/settings`'s staff-access panel: the invite-only admin surface `auth.ts`'s sign-in gate
 * requires to be usable at all (wp4-vet.md's auth section: `owner|staff` roles) - an owner invites
 * an email here before that person can ever sign in through Google or a magic link. Role and
 * revoke controls only render for the CURRENT session's owner (`isOwner`); a non-owner still sees
 * the read-only roster so everyone can see who has access. */
export function StaffSection({initial, isOwner, currentStaffId}: {initial: StaffDoc[]; isOwner: boolean; currentStaffId?: string}) {
  const snackbar = useSnackbar();
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

  async function update(staffId: string, patch: {role?: StaffRole; disabled?: boolean}) {
    setBusy(true);
    try {
      const res = await fetch(`/api/settings/staff/${staffId}`, {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not update this staff member.");
      await refresh();
    } catch (err) {
      snackbar.show(err instanceof Error ? err.message : "Could not update this staff member.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormSection
      title="Staff access"
      helperText="Only an invited email can sign in with Google or a magic link. Invite a colleague before sharing this deployment's URL with them."
    >
      <DataTable
        columns={[
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
                        {/* Same wrapper-width rule as the invite row below - w-auto on the control
                            itself loses to the base w-full. */}
                        <div className="w-28 shrink-0">
                          <Select
                            value={s.role}
                            disabled={busy}
                            onChange={(e) => update(s.staffId, {role: e.target.value as StaffRole})}
                            aria-label={`Role for ${s.email}`}
                          >
                            {staffRoleOptions.map((option) => (
                              <option key={option} value={option}>
                                {staffRoleLabel[option]}
                              </option>
                            ))}
                          </Select>
                        </div>
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
        /* Widths live on wrappers, never as className on Input/Select: the controls' base class is
           w-full, and a bare `w-auto` override loses the stylesheet-order fight - the Select grew to
           full width and squeezed the flex-1 email field to a sliver (Kenneth's 2026-09-01 report). */
        <div className="mt-4 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <FormField label="Invite by email" htmlFor="invite-email">
              <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@clinic.example" />
            </FormField>
          </div>
          <div className="w-32 shrink-0">
            <Select value={role} onChange={(e) => setRole(e.target.value as StaffRole)} aria-label="Role to invite as">
              {staffRoleOptions.map((option) => (
                <option key={option} value={option}>
                  {staffRoleLabel[option]}
                </option>
              ))}
            </Select>
          </div>
          <Button className="shrink-0" onClick={invite} disabled={busy}>
            Invite
          </Button>
        </div>
      )}
    </FormSection>
  );
}
