"use client";

import {useEffect, useState} from "react";
import {useRouter} from "next/navigation";
import {Button, Input} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {useSnackbar} from "@/components/ui/Snackbar";
import type {StaffDoc} from "@/lib/models/Staff";

type ProfileFieldKey = "firstName" | "lastName" | "title" | "accreditationNumber";

/**
 * `/settings`'s WP4.13 self-service counterpart to `StaffSection`'s owner-only Practitioner
 * profiles fields (Kenneth issue 3: "split the name of the vet from display name to first name,
 * last name... qualifications / title field... government accreditation number") - modelled on
 * the sibling `MyWalletSection`, always scoped to the signed-in staff member's OWN row via `PATCH
 * /api/settings/staff/me/profile`; there is no staffId picker here because this card can only ever
 * touch one row. An owner can still set or clear any vet's fields (including their own) from
 * "Practitioner profiles" above - this card is an additional, self-service path onto the SAME
 * `setStaffProfile` write, never a second source of truth.
 *
 * The government accreditation number this card edits never leaves Settings - it is not sent on
 * the public booking wire, the calendar, ICS, or emails (`Staff.ts`'s own doc comment on
 * `accreditationNumber`).
 */
export function MyProfileSection({initial}: {initial: StaffDoc}) {
  const snackbar = useSnackbar();
  const router = useRouter();
  const [firstName, setFirstName] = useState(initial.firstName ?? "");
  const [lastName, setLastName] = useState(initial.lastName ?? "");
  const [title, setTitle] = useState(initial.title ?? "");
  const [accreditationNumber, setAccreditationNumber] = useState(initial.accreditationNumber ?? "");
  const [busy, setBusy] = useState(false);

  // Same convention as MyWalletSection: resync the draft when the server's own value changes
  // underneath this component (a `router.refresh()` after this card's own save, or an owner
  // editing the same row from Practitioner profiles on this same page load).
  useEffect(() => setFirstName(initial.firstName ?? ""), [initial.firstName]);
  useEffect(() => setLastName(initial.lastName ?? ""), [initial.lastName]);
  useEffect(() => setTitle(initial.title ?? ""), [initial.title]);
  useEffect(() => setAccreditationNumber(initial.accreditationNumber ?? ""), [initial.accreditationNumber]);

  const stored: Record<ProfileFieldKey, string> = {
    firstName: initial.firstName ?? "",
    lastName: initial.lastName ?? "",
    title: initial.title ?? "",
    accreditationNumber: initial.accreditationNumber ?? "",
  };
  const trimmed: Record<ProfileFieldKey, string> = {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    title: title.trim(),
    accreditationNumber: accreditationNumber.trim(),
  };
  const fieldKeys: ProfileFieldKey[] = ["firstName", "lastName", "title", "accreditationNumber"];
  const dirty = fieldKeys.some((key) => trimmed[key] !== stored[key]);

  function resetDrafts() {
    setFirstName(stored.firstName);
    setLastName(stored.lastName);
    setTitle(stored.title);
    setAccreditationNumber(stored.accreditationNumber);
  }

  async function save() {
    setBusy(true);
    try {
      const body: Partial<Record<ProfileFieldKey, string | null>> = {};
      for (const key of fieldKeys) {
        if (trimmed[key] !== stored[key]) body[key] = trimmed[key] === "" ? null : trimmed[key];
      }
      const res = await fetch("/api/settings/staff/me/profile", {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
      });
      const responseBody = await res.json().catch(() => null);
      if (!res.ok) throw new Error(responseBody?.error?.message ?? "Could not update your profile.");
      snackbar.show("Profile saved", "ok");
      // Same idiom as MyWalletSection/StaffSection's own mutations - the roster's Name column and
      // the calendar both read these fields server-side and have no other way to learn they
      // changed.
      router.refresh();
    } catch (err) {
      resetDrafts();
      snackbar.show(err instanceof Error ? err.message : "Could not update your profile.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormSection
      title="My profile"
      helperText="Your name, qualification/title, and government accreditation number. The accreditation number is kept internal to this clinic and never shown to clients or on the public booking page."
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="First name" htmlFor="my-first-name">
          <Input id="my-first-name" value={firstName} disabled={busy} onChange={(e) => setFirstName(e.target.value)} />
        </FormField>
        <FormField label="Last name" htmlFor="my-last-name">
          <Input id="my-last-name" value={lastName} disabled={busy} onChange={(e) => setLastName(e.target.value)} />
        </FormField>
        <FormField label="Title / qualification" htmlFor="my-title" helperText="Shown after your name, e.g. Jane Smith, DVM.">
          <Input id="my-title" value={title} disabled={busy} placeholder="DVM" onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField
          label="Government accreditation number"
          htmlFor="my-accreditation-number"
          helperText="Internal only - never shown to clients or on the public booking page."
        >
          <Input
            id="my-accreditation-number"
            value={accreditationNumber}
            disabled={busy}
            placeholder="USDA accreditation number"
            onChange={(e) => setAccreditationNumber(e.target.value)}
          />
        </FormField>
      </div>
      <div className="flex items-center gap-2">
        <Button disabled={busy || !dirty} onClick={save}>
          {busy ? "Saving..." : "Save"}
        </Button>
      </div>
    </FormSection>
  );
}
