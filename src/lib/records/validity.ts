import type {RecordArtifactStatus} from "@/lib/models/RecordArtifact";

/**
 * "Valid through the END of validUntil in UTC" (plan section 11.2's non-negotiable, verbatim) - a
 * record's clinical validity window closes at the START of the day AFTER `validUntil`, in UTC
 * (`validUntil` T24:00:00Z, equivalently `validUntil` + 1 day, T00:00:00Z), never at the START of
 * `validUntil`'s own day. A record whose `validUntil` is today is still VALID for the whole of
 * today in UTC, regardless of the reader's own local timezone. Symmetrically, `validFrom`'s window
 * OPENS at the START of `validFrom`'s own day in UTC (T00:00:00Z) - a record whose `validFrom` is
 * today is already valid from the start of today, in UTC.
 *
 * Six-way, not two (WP4.14V grade round 1, D1, MAJOR - a fail-open this wave's own verify mode had
 * shipped): `status === "revoked"` always wins over every date comparison - a revoked-and-still-
 * inside-its-window record reports `"revoked"`, never `"valid"`. `"pending"` covers every status
 * that has not yet reached (or has left, other than by revocation) an anchored `"active"` state -
 * `draft`/`issuing`/`error` have nothing on chain yet to be valid or expired about. `"hidden"` and
 * `"not_yet_valid"` exist because `validFrom`/`validUntil` are ordinary MASKABLE clinical leaves,
 * not part of the seven non-maskable keyPaths (`specs/leaf-commitment.md` section 16) - a
 * THIRD-PARTY-PRESENTED artifact (`lib/records/verifier.ts`'s caller) may legally withhold either
 * or both, and a verifier that has not been shown a bound has no basis to guess `"valid"`. This
 * deployment's OWN records (the Records tab, `RecordsCard.tsx`) always have both in storage - only
 * a presented artifact can genuinely lack one - but the decision procedure is the SAME function
 * either way, not two independently-reasoned implementations of the identical six-way rule.
 */
export type RecordValidity = "valid" | "expired" | "revoked" | "pending" | "hidden" | "not_yet_valid";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The exact UTC instant `validUntil`'s clinical window closes - the start of the NEXT calendar day
 * at 00:00:00.000 UTC (`validUntil` T24:00:00Z). Throws on anything not `YYYY-MM-DD` - the same
 * shape `lib/schemas/common.ts`'s `isoDate` already enforces at issuance time, so a value stored on
 * a `RecordArtifact` leaf is never anything else in production.
 */
export function recordValidUntilCutoffUtc(validUntilIsoDate: string): Date {
  const match = ISO_DATE_RE.exec(validUntilIsoDate);
  if (!match) throw new Error(`recordValidUntilCutoffUtc: not an ISO date (YYYY-MM-DD): ${validUntilIsoDate}`);
  const [, y, m, d] = match as unknown as [string, string, string, string];
  // Date.UTC's own day-rollover arithmetic (e.g. day 32 of a 31-day month, or day 29 of a
  // non-leap February) correctly rolls into the next month/year - exactly the "start of the next
  // calendar day" this function needs, with no hand-written month-length table.
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1, 0, 0, 0, 0));
}

/** The exact UTC instant `validFrom`'s clinical window OPENS - the start of `validFrom`'s own
 * calendar day at 00:00:00.000 UTC, symmetric to `recordValidUntilCutoffUtc` above (which is the
 * start of the day AFTER `validUntil`, not `validUntil`'s own start). Throws on anything not
 * `YYYY-MM-DD`, matching that function's own contract. */
export function recordValidFromStartUtc(validFromIsoDate: string): Date {
  const match = ISO_DATE_RE.exec(validFromIsoDate);
  if (!match) throw new Error(`recordValidFromStartUtc: not an ISO date (YYYY-MM-DD): ${validFromIsoDate}`);
  const [, y, m, d] = match as unknown as [string, string, string, string];
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0));
}

/**
 * The single shared decision procedure (WP4.14V grade round 1 D1) - called both by the Records tab
 * (this deployment's own rows, where both bounds always exist in storage) and by
 * `lib/records/verifier.ts` (a third-party-presented artifact, where either may be legally
 * withheld). `validFromIsoDate`/`validUntilIsoDate` are `undefined` exactly when that leaf was not
 * disclosed - never an empty string or a sentinel, so a caller reading off a masked artifact passes
 * `undefined` directly, no translation needed. `now` is a parameter (defaulting to the real clock)
 * so a test can pin an exact instant on either side of a UTC boundary without faking global time.
 */
export function computeRecordValidity(
  status: RecordArtifactStatus,
  validFromIsoDate: string | undefined,
  validUntilIsoDate: string | undefined,
  now: Date = new Date(),
): RecordValidity {
  if (status === "revoked") return "revoked";
  if (status !== "active") return "pending";
  if (!validFromIsoDate || !validUntilIsoDate) return "hidden";
  if (now.getTime() < recordValidFromStartUtc(validFromIsoDate).getTime()) return "not_yet_valid";
  return now.getTime() < recordValidUntilCutoffUtc(validUntilIsoDate).getTime() ? "valid" : "expired";
}

/** Renders a bare calendar date (`YYYY-MM-DD` - `vaccinationDate`/`validFrom`/`validUntil`/
 * `nextDueDate`/`vaccineExpirationDate`, all `TypeTag.String` leaves with no time-of-day component
 * at all) for display. Explicitly pinned to the `"UTC"` Intl timezone - NEVER the clinic's own
 * timezone or the rendering host's timezone - so a calendar-only date can never shift by a day in
 * either direction depending on who is looking at it or where the server happens to run; the exact
 * same anti-shift reasoning `recordValidUntilCutoffUtc` above applies to. */
export function formatIsoCalendarDate(isoDate: string): string {
  if (!ISO_DATE_RE.test(isoDate)) return isoDate;
  return new Intl.DateTimeFormat("en-US", {dateStyle: "medium", timeZone: "UTC"}).format(new Date(`${isoDate}T00:00:00.000Z`));
}
