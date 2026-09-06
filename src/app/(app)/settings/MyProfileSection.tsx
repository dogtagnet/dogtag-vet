"use client";

import {useEffect, useState} from "react";
import {useRouter} from "next/navigation";
import {Button, Input} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {useSnackbar} from "@/components/ui/Snackbar";
import type {StaffDoc} from "@/lib/models/Staff";

type ProfileFieldKey = "firstName" | "lastName" | "title" | "accreditationNumber";

const PROFILE_FIELD_KEYS: readonly ProfileFieldKey[] = ["firstName", "lastName", "title", "accreditationNumber"];

type FieldErrors = Partial<Record<ProfileFieldKey, string>>;

function isProfileFieldKey(key: string): key is ProfileFieldKey {
  return (PROFILE_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * The API's 400 shape: error.details is a zod flatten() - fieldErrors keyed by payload field.
 * Same convention as ClientForm's own `parseFieldErrors` (there is no shared helper between the
 * two - each form's FieldErrors type is keyed to its own field union, so a shared generic would
 * buy nothing over restating this small function once per form).
 */
function parseFieldErrors(body: unknown): {message?: string; fields: FieldErrors} {
  const error = (body as {error?: {message?: string; details?: {fieldErrors?: Record<string, string[]>}}} | null)?.error;
  const fields: FieldErrors = {};
  for (const [key, messages] of Object.entries(error?.details?.fieldErrors ?? {})) {
    if (messages?.[0] && isProfileFieldKey(key)) fields[key] = messages[0];
  }
  return {message: error?.message, fields};
}

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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

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
  const fieldKeys = PROFILE_FIELD_KEYS;
  const dirty = fieldKeys.some((key) => trimmed[key] !== stored[key]);

  const fieldSetters: Record<ProfileFieldKey, (value: string) => void> = {
    firstName: setFirstName,
    lastName: setLastName,
    title: setTitle,
    accreditationNumber: setAccreditationNumber,
  };

  function setField(key: ProfileFieldKey, value: string) {
    fieldSetters[key](value);
    // Editing a field retires its stale error; the next save revalidates (ClientForm's own
    // convention - see its `set()`).
    setFieldErrors((prev) => (prev[key] ? {...prev, [key]: undefined} : prev));
  }

  async function save() {
    setBusy(true);
    setFieldErrors({});
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
      if (!res.ok) {
        // Surface WHICH field the server rejected instead of a generic retry toast, and leave the
        // typed value in place (not `resetDrafts()`) so the inline error sits next to the text
        // that triggered it - same convention as ClientForm's own save-failure handling.
        const {message, fields} = parseFieldErrors(responseBody);
        setFieldErrors(fields);
        const firstField = Object.entries(fields).find((entry): entry is [string, string] => Boolean(entry[1]));
        throw new Error(
          firstField
            ? `${fieldLabel(firstField[0] as ProfileFieldKey)}: ${firstField[1]}`
            : (message ?? "Could not update your profile."),
        );
      }
      snackbar.show("Profile saved", "ok");
      // Same idiom as MyWalletSection/StaffSection's own mutations - the roster's Name column and
      // the calendar both read these fields server-side and have no other way to learn they
      // changed.
      router.refresh();
    } catch (err) {
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
        <FormField label="First name" htmlFor="my-first-name" error={fieldErrors.firstName}>
          <Input id="my-first-name" value={firstName} disabled={busy} onChange={(e) => setField("firstName", e.target.value)} />
        </FormField>
        <FormField label="Last name" htmlFor="my-last-name" error={fieldErrors.lastName}>
          <Input id="my-last-name" value={lastName} disabled={busy} onChange={(e) => setField("lastName", e.target.value)} />
        </FormField>
        <FormField
          label="Title / qualification"
          htmlFor="my-title"
          helperText="Shown after your name, e.g. Jane Smith, DVM."
          error={fieldErrors.title}
        >
          <Input id="my-title" value={title} disabled={busy} placeholder="DVM" onChange={(e) => setField("title", e.target.value)} />
        </FormField>
        <FormField
          label="Government accreditation number"
          htmlFor="my-accreditation-number"
          helperText="Internal only - never shown to clients or on the public booking page."
          error={fieldErrors.accreditationNumber}
        >
          <Input
            id="my-accreditation-number"
            value={accreditationNumber}
            disabled={busy}
            placeholder="USDA accreditation number"
            onChange={(e) => setField("accreditationNumber", e.target.value)}
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

function fieldLabel(key: ProfileFieldKey): string {
  switch (key) {
    case "firstName":
      return "First name";
    case "lastName":
      return "Last name";
    case "title":
      return "Title / qualification";
    case "accreditationNumber":
      return "Government accreditation number";
  }
}
