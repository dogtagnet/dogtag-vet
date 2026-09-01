import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {toPlain} from "@/lib/toPlain";
import {randomUUID} from "node:crypto";

export type StaffRole = "owner" | "staff" | "vet";

/**
 * `isVetOrOwner` and `practitionerDisplayName` used to live here, but both are pure functions with
 * no dependency on mongoose/node:crypto, and this file is NOT client-safe to import values from
 * (it registers a Mongoose model and uses `node:crypto` at module scope) - a client component
 * doing `import {isVetOrOwner} from "@/lib/models/Staff"` drags this entire module into its bundle.
 * They now live in `@/lib/staffRoleTone`, which only ever takes `import type` from here and is
 * safe to import a value from anywhere, client or server. Import them from there.
 */

/**
 * A staff account's role, keyed by email and independent of whichever Auth.js adapter/provider
 * authenticated the sign-in (Google, email magic link, or the dev-only credentials provider) -
 * the `jwt` callback in src/lib/auth.ts looks this up by email and stamps `role` onto the token.
 * The FIRST staff record ever created becomes `owner`; every one after that defaults to `staff`.
 *
 * WP4.7 adds `vet`: whitelisted (app-side gate, `requireVetSession` in `staffApi.ts`) to reach the
 * DogTag issuance surfaces alongside `owner`. The actual authority is on-chain (`VetIssuer`'s own
 * `operators` whitelist, granted per the vet's personal wallet - see `wp4.7-vet-role-practitioner-
 * availability.md` D4); this app-side role is UX plus defense in depth, never the source of truth.
 * `vet` is also a practitioner-eligible role for per-practitioner availability (D2) - see
 * `Staff.bookable` below.
 *
 * `disabled` gates sign-in for Google/email magic-link (never for the dev-only credentials
 * provider, which stays open by design - see `auth.ts`'s `signIn` callback): a staff row must
 * exist AND be un-disabled for one of those two providers to complete a sign-in. This is also why
 * "revoke access" (`disableStaff`) flips this flag rather than deleting the row outright - a
 * deleted row would look, to `ensureStaffForEmail`, identical to an email nobody has ever invited,
 * and the very next token refresh (the `jwt` callback runs `ensureStaffForEmail` on every one, not
 * only at initial sign-in) would silently re-provision it as a fresh `staff` account, undoing the
 * revocation without anyone touching the UI again.
 */
export interface StaffDoc {
  staffId: string;
  email: string;
  name?: string;
  role: StaffRole;
  disabled: boolean;
  /** WP4.7 D2: whether this staff row is a selectable practitioner for per-practitioner
   * availability - only meaningful for `role` `vet`/`owner` (a `staff` row is never a
   * practitioner regardless of this flag; the availability engine, A4, filters on both).
   * Defaults false so every pre-existing row (and any newly-invited one that hasn't opted in)
   * behaves exactly as it does today - Whole-clinic mode never even reads this field. */
  bookable: boolean;
  /** WP4.7 D2: falls back to the email local-part (the UI's job, not this field's) until set -
   * shown on calendar chips/pickers instead of a raw email once a clinic has more than one
   * practitioner. */
  displayName?: string;
  /** WP4.7 D4: this staff member's own wallet, recorded so the Settings "Issuance operators"
   * panel can read its on-chain `operators(address)` status and submit `addOperator`/
   * `removeOperator` for it. Always lowercased on write (`schemas/staff.ts`'s
   * `lowercaseHexAddress`) - this app's own canonical casing for a field it compares by exact
   * string equality, unlike `ClinicSettings`'s checksum-preserving address fields. */
  walletAddress?: string;
  createdAt: Date;
  updatedAt: Date;
}

const staffSchema = new Schema<StaffDoc>(
  {
    staffId: {type: String, required: true, unique: true, default: () => randomUUID()},
    email: {type: String, required: true, unique: true, lowercase: true, trim: true},
    name: String,
    role: {type: String, enum: ["owner", "staff", "vet"], required: true, default: "staff"},
    disabled: {type: Boolean, required: true, default: false},
    bookable: {type: Boolean, required: true, default: false},
    displayName: String,
    walletAddress: {type: String, lowercase: true},
  },
  {timestamps: true},
);

export const Staff = getOrCreateModel<StaffDoc>("Staff", staffSchema);

/**
 * Whether a sign-in for `email` through a gated provider (Google, email magic link) should be
 * allowed to proceed at all - called from `auth.ts`'s `signIn` callback, BEFORE any Staff row is
 * created, so it never provisions anything itself:
 *
 * - The very first sign-in this deployment ever sees (no Staff row exists yet, for any email) is
 *   always allowed - this is the bootstrap path that lets a fresh clone's operator claim `owner`.
 * - After that, an email may sign in only if it already has a non-disabled Staff row - i.e. an
 *   owner invited it (`inviteStaff`) beforehand. An unrecognized email is refused outright rather
 *   than silently becoming a full-access staff account, closing the open self-registration hole
 *   the dev-only credentials provider is deliberately exempt from (see `auth.ts`).
 */
export async function isEmailAllowedToSignIn(email: string): Promise<boolean> {
  const normalized = email.toLowerCase().trim();
  const staffCount = await Staff.countDocuments();
  if (staffCount === 0) return true;
  const existing = await Staff.findOne({email: normalized}).lean<StaffDoc>();
  return Boolean(existing && !existing.disabled);
}

/** Look up (or provision) the Staff record for a freshly authenticated email: the first ever
 * staff record becomes `owner`, every subsequent one is `staff`. Called from the Auth.js `jwt`
 * callback on every sign-in AND every token refresh, so it is idempotent for an already-provisioned
 * email - callers that only want to gate a NEW sign-in should check `isEmailAllowedToSignIn` first
 * (this function itself performs no gating and will happily create a first-ever row for any
 * email, by design - the dev-only credentials provider relies on exactly that). */
export async function ensureStaffForEmail(email: string, name?: string): Promise<StaffDoc> {
  const normalized = email.toLowerCase().trim();
  const existing = await Staff.findOne({email: normalized}).lean<StaffDoc>();
  if (existing) return existing;

  const staffCount = await Staff.countDocuments();
  const role: StaffRole = staffCount === 0 ? "owner" : "staff";
  const created = await Staff.create({email: normalized, name, role});
  return created.toObject();
}

/** Pre-provisions a Staff row for an email that has not signed in yet - the invite half of the
 * gate `isEmailAllowedToSignIn` enforces. Owner-only (`requireOwnerSession`); refuses to
 * re-invite an email that already has a row (use `setStaffDisabled`/`setStaffRole` to change an
 * existing one instead). */
export async function inviteStaff(email: string, role: StaffRole): Promise<StaffDoc> {
  const normalized = email.toLowerCase().trim();
  const existing = await Staff.findOne({email: normalized}).lean<StaffDoc>();
  if (existing) throw new Error("A staff record for this email already exists.");
  try {
    const created = await Staff.create({email: normalized, role});
    return created.toObject();
  } catch (err) {
    // The findOne-then-create above is not atomic - a concurrent invite for the same email can
    // slip between the two, in which case the unique index on `email` is what actually prevents
    // the duplicate. Map that race to the same friendly message rather than surfacing a raw
    // `E11000 duplicate key` error to the operator.
    if (err && typeof err === "object" && "code" in err && (err as {code?: number}).code === 11000) {
      throw new Error("A staff record for this email already exists.");
    }
    throw err;
  }
}

export async function listStaff(): Promise<StaffDoc[]> {
  const staff = await Staff.find({}).sort({createdAt: 1}).lean<StaffDoc[]>();
  // Back-compat: same reasoning as `getBookingSettings()`'s `schedulingMode` coalesce - `.lean()`
  // returns a pre-existing row (any Staff invited before WP4.7) exactly as stored, with `bookable`
  // entirely absent rather than defaulted, even though the type promises a real boolean. Coalesced
  // here, once, so every caller (the roster table's checkbox, the A5 practitioner picker) can trust
  // the type instead of each needing its own `?? false`.
  //
  // toPlain() strips the lean doc's bson `_id` (found pre-existing while building A5's own visual
  // check: settings/page.tsx passes this straight into <StaffSection initial={staff} /> across a
  // Server-Component-to-Client-Component boundary, which Next.js logs as "Only plain objects can be
  // passed..." for exactly this reason - unrelated to WP4.7's own changes here, but cheap to fix in
  // passing since every other page-boundary query in this codebase already goes through toPlain()).
  return toPlain(staff.map((s) => ({...s, bookable: s.bookable ?? false})));
}

export async function setStaffDisabled(staffId: string, disabled: boolean): Promise<StaffDoc | null> {
  return Staff.findOneAndUpdate({staffId}, {$set: {disabled}}, {new: true}).lean<StaffDoc>();
}

export async function setStaffRole(staffId: string, role: StaffRole): Promise<StaffDoc | null> {
  return Staff.findOneAndUpdate({staffId}, {$set: {role}}, {new: true}).lean<StaffDoc>();
}

/**
 * WP4.7 A3: updates the practitioner-profile fields (`bookable`, `displayName`, `walletAddress`) -
 * owner-only via the same `PATCH /api/settings/staff/:staffId` route `setStaffRole`/
 * `setStaffDisabled` back; self-service editing of one's own row is explicitly OUT of scope for
 * this WP (an owner edits everyone's, including their own). `undefined` in `patch` means "leave
 * unchanged" for every field EXCEPT `walletAddress`, which additionally accepts an explicit `null`
 * to mean "clear it" (`$unset`) - a vet who no longer wants a wallet on file must be able to remove
 * it, not merely overwrite it with a different one.
 */
export async function setStaffProfile(
  staffId: string,
  patch: {bookable?: boolean; displayName?: string; walletAddress?: string | null},
): Promise<StaffDoc | null> {
  const set: Partial<Pick<StaffDoc, "bookable" | "displayName" | "walletAddress">> = {};
  const unset: Record<string, ""> = {};
  if (patch.bookable !== undefined) set.bookable = patch.bookable;
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.walletAddress === null) unset.walletAddress = "";
  else if (patch.walletAddress !== undefined) set.walletAddress = patch.walletAddress;

  const update: Record<string, unknown> = {};
  if (Object.keys(set).length > 0) update.$set = set;
  if (Object.keys(unset).length > 0) update.$unset = unset;
  if (Object.keys(update).length === 0) return Staff.findOne({staffId}).lean<StaffDoc>();

  return Staff.findOneAndUpdate({staffId}, update, {new: true}).lean<StaffDoc>();
}

export async function countActiveOwners(): Promise<number> {
  return Staff.countDocuments({role: "owner", disabled: false});
}

/**
 * Whether applying `patch` to `target` would strip `target`'s CURRENT "active owner" status - i.e.
 * it is right now an active (non-disabled) owner, and the patch would either move its role away
 * from `owner` (to `staff` OR the newer `vet` - any non-owner role trips this, not a hardcoded
 * `"staff"` check) or disable it outright. Pure and DB-free by design: `PATCH
 * /api/settings/staff/:staffId` (`api/settings/staff/[staffId]/route.ts`) combines this with a
 * fresh `countActiveOwners()` read to refuse a change that would leave zero active owners, and
 * keeping the boolean math here (rather than inline in the route) lets it be unit-tested directly -
 * see `tests/unit/models/staffRoleGuard.test.ts` - without a database, including the owner -> vet
 * demotion path this function's own guard against a hardcoded two-role check exists to catch.
 */
export function wouldRemoveActiveOwnerStatus(
  target: Pick<StaffDoc, "role" | "disabled">,
  patch: {role?: StaffRole; disabled?: boolean},
): boolean {
  return (
    target.role === "owner" &&
    !target.disabled &&
    ((patch.role !== undefined && patch.role !== "owner") || patch.disabled === true)
  );
}
