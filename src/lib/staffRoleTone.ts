import type {StaffDoc, StaffRole} from "@/lib/models/Staff";
import type {StatusTone} from "@/components/ui/StatusBadge";

/**
 * Client-safe StaffRole/StaffDoc helpers - pure functions and constant tables only, with `import
 * type` for everything pulled from `@/lib/models/Staff`. That distinction is load-bearing, not
 * style: `Staff.ts` is a Mongoose model file (imports `mongoose` and `node:crypto` at module
 * scope), so a *value* import from it (e.g. a plain `import {isVetOrOwner} from
 * "@/lib/models/Staff"`) drags that whole server-only module graph into any client bundle that
 * imports it - which is exactly what happened when `Sidebar.tsx` first added the nav-visibility
 * check (webpack's client compiler failed on `node:crypto`, an "UnhandledSchemeError", caught by
 * the WP4.7A e2e harness smoke test). `import type` is always erased at compile time, so this file
 * can safely reference `Staff.ts`'s types while staying import-safe from both client components
 * and server code. Anything here that a client component might need - `isVetOrOwner` today,
 * `practitionerDisplayName` for A5/A6's practitioner picker and calendar chips - belongs here, not
 * in `Staff.ts` itself, even when the primary caller today is still server-side.
 */
export const staffRoleTone: Record<StaffRole, StatusTone> = {
  owner: "info",
  staff: "neutral",
  vet: "ok",
};

export const staffRoleLabel: Record<StaffRole, string> = {
  owner: "Owner",
  staff: "Staff",
  vet: "Vet",
};

/** Iteration order for role `<select>`s (invite + roster) - a single source of truth so every
 * picker offers the same three roles in the same order rather than each call site hardcoding its
 * own `<option>` list (the bug this replaces: a hardcoded pair of options silently excluding any
 * role added later). */
export const staffRoleOptions: StaffRole[] = ["staff", "vet", "owner"];

/**
 * Whether `role` may reach the DogTag issuance surfaces (WP4.7 A2) - `vet` and `owner` both
 * qualify, `staff` and an absent/unauthenticated role do not. The single predicate every gated
 * surface shares - `requireVetSession` (`staffApi.ts`), `/tags` + `/tags/issue`'s page-level
 * redirect, and the sidebar's nav-group visibility (`Sidebar.tsx`) - rather than each re-deriving
 * its own and risking drift (e.g. one of them regressing to a hardcoded `=== "vet"` that forgets
 * `owner`). See `tests/unit/models/staffRoleGuard.test.ts` for the role x surface matrix this makes
 * trivial to state once.
 */
export function isVetOrOwner(role: StaffRole | undefined | null): boolean {
  return role === "vet" || role === "owner";
}

/**
 * A bookable practitioner's display name for calendar chips, the practitioner picker (A5/A6), and
 * the public availability response's `practitioners[].name` (D5) - the ONE composition point
 * every one of those surfaces shares, so the tier order below can never drift between them.
 *
 * WP4.13 (Kenneth issue 3) widens this from two tiers to three:
 * 1. `firstName`/`lastName` (either or both set) - composed as `"First Last"`, or just whichever
 *    one is set if only one is - with `, Title` appended when `title` is also set ("Jane Smith,
 *    DVM"). This is the CURRENT, encouraged way to name a practitioner.
 * 2. `displayName` - DEPRECATED (see `Staff.ts`'s own doc comment): a legacy free-text name from
 *    before the first/last split existed, still honored for any row nobody has updated yet. Never
 *    gets a title appended - a title only ever pairs with tier 1's real first/last fields.
 * 3. The email's local part (everything before `@`) - a reasonable default rather than showing a
 *    full email address (or nothing) on a public-facing slot button. Two e2e specs
 *    (`practitioner-mode.spec.ts`, `vet-wallet-status.spec.ts`) depend on this tier staying
 *    reachable for a practitioner with no name recorded at all.
 *
 * Pure and reused everywhere a practitioner needs a human-readable name so this fallback rule
 * lives in exactly one place. See `practitionerInitials` below for the SEPARATE function that
 * derives initials - deliberately never by splitting this function's own output (a composed
 * "Jane Smith, DVM" line splits on whitespace into the wrong pair of letters; initials are derived
 * from the same raw fields instead).
 */
export function practitionerDisplayName(
  staff: Pick<StaffDoc, "firstName" | "lastName" | "title" | "displayName" | "email">,
): string {
  const firstName = staff.firstName?.trim();
  const lastName = staff.lastName?.trim();
  if (firstName || lastName) {
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    const title = staff.title?.trim();
    return title ? `${fullName}, ${title}` : fullName;
  }
  if (staff.displayName?.trim()) return staff.displayName.trim();
  return staff.email.split("@")[0] ?? staff.email;
}

/** Splits a plain (untitled) name into up to 2 initials: a single word (e.g. an email local part
 * or a lone first name) takes its own first 2 characters; two or more words take the first
 * character of the first and of the last word. Shared by `practitionerInitials` for every tier -
 * never given a string that might still carry a trailing ", Title" (callers strip that first). */
function initialsFromWords(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return `${(parts[0] ?? "")[0] ?? ""}${(parts[parts.length - 1] ?? "")[0] ?? ""}`.toUpperCase();
}

/**
 * WP4.13 - a practitioner's initials for dense UI (calendar day-view column headers, appointment
 * chips), derived from the SAME raw fields `practitionerDisplayName` composes from, but NEVER by
 * splitting that function's own composed output. That trap is real: `practitionerDisplayName`'s
 * tier-1 output for `{firstName: "Jane", lastName: "Smith", title: "DVM"}` is `"Jane Smith, DVM"`,
 * and naively splitting THAT on whitespace takes the first letter of `"Jane"` and of `"DVM"` -
 * "JD", not the correct "JS" - because the title tags along as if it were part of the name. This
 * function instead uses `firstName`/`lastName` directly (tier 1) whenever either is set, so a
 * title never enters the computation at all; otherwise it falls back to the SAME tier-2/3 name
 * `practitionerDisplayName` would show (the deprecated `displayName`, else the email local part),
 * with any accidentally-embedded ", trailing text" stripped first - a legacy `displayName` set
 * before this WP could freely contain a comma (someone's own manual "Name, Title" workaround),
 * and stripping it here keeps that case from producing nonsense initials the way the trap above
 * would.
 */
export function practitionerInitials(
  staff: Pick<StaffDoc, "firstName" | "lastName" | "displayName" | "email">,
): string {
  const firstName = staff.firstName?.trim();
  const lastName = staff.lastName?.trim();
  if (firstName || lastName) return initialsFromWords([firstName, lastName].filter(Boolean).join(" "));

  const fallbackName = staff.displayName?.trim() || staff.email.split("@")[0] || staff.email;
  const beforeFirstComma = fallbackName.split(",")[0] ?? fallbackName;
  return initialsFromWords(beforeFirstComma);
}

/**
 * Whether `staff` has an EXPLICIT name on file - tier 1 (`firstName`/`lastName`) or the deprecated
 * tier 2 (`displayName`) - as opposed to only ever resolving `practitionerDisplayName` through the
 * tier-3 email fallback. `practitionerDisplayName` itself always returns a usable string either
 * way (the email fallback IS the intended behavior for calendar chips/the booking wire, where
 * SOME name must always render) - this predicate exists only for the staff roster's own Name
 * column, which sits right next to an Email column already: showing the identical email-derived
 * text twice, once per column, would read as a display bug rather than useful information, so the
 * roster leaves that column blank for a staff member nobody has ever named.
 */
export function hasExplicitName(staff: Pick<StaffDoc, "firstName" | "lastName" | "displayName">): boolean {
  return Boolean(staff.firstName?.trim() || staff.lastName?.trim() || staff.displayName?.trim());
}

/**
 * WP4.7C item 3 - the on-chain answer to "can this recorded wallet actually issue DogTags right
 * now", resolved server-side by `issuanceOperatorStatus.ts`'s `resolveOperatorStatus` (which is
 * NOT client-safe - it reads the chain). The type lives HERE, not there, so this file stays the
 * single client-safe source of truth for status vocabulary (`operatorStatusBadge`/
 * `operatorStatusExplanation` below, plus `decideVetWalletBanner`) that both server pages and
 * client components (the "My issuance wallet" card, the /tags + /tags/issue banners, and
 * OperatorsSection's one new isError branch) can share without any of them needing to import a
 * server-only module - `issuanceOperatorStatus.ts` imports this type back with `import type`.
 *
 * Five states, not three - Kenneth's own ask only names two ("whitelisted" / "not whitelisted"),
 * but the design intent this WP was launched under is stricter: "no address recorded" and "the
 * chain could not be read" are each their OWN honest state, never silently folded into
 * "not-whitelisted" (which would be a false claim - "not whitelisted" means the chain was actually
 * asked and answered false). `not-configured` (this clinic's clone address itself is not set up
 * yet) is its own state for the same reason - there is nothing to check yet, which is different
 * from checking and failing.
 */
export type OperatorStatus = "whitelisted" | "not-whitelisted" | "no-address" | "not-configured" | "unreadable";

/** Badge tone/label per `OperatorStatus` - the vocabulary `operatorStatusExplanation` below and
 * every surface that renders a badge for this concept shares. Deliberately does NOT touch
 * OperatorsSection's own pre-existing "Active"/"Inactive" labels (asserted verbatim by
 * `e2e/practitioner-mode.spec.ts`) - that component uses this table only for its one new
 * `isError` branch, a state it previously had no representation for at all. */
export const operatorStatusBadge: Record<OperatorStatus, {tone: StatusTone; label: string}> = {
  whitelisted: {tone: "ok", label: "Whitelisted"},
  "not-whitelisted": {tone: "danger", label: "NOT whitelisted"},
  "no-address": {tone: "neutral", label: "No address on file"},
  "not-configured": {tone: "neutral", label: "Could not verify"},
  unreadable: {tone: "warn", label: "Could not verify"},
};

/** The explanatory sentence per `OperatorStatus`, shared verbatim between the "My issuance
 * wallet" card and the /tags + /tags/issue banners (`decideVetWalletBanner` below) so the two
 * surfaces can never drift into disagreeing prose for the identical fact. The `not-whitelisted`
 * text is Kenneth's own ask, quoted close to verbatim (K2, WP4.7C's own contract): "...show some
 * warning that their address is not whitelisted although they are owner / vet and cannot issue
 * dogtag." The OTHER four states are this WP's own honest extensions of that one sentence -
 * `no-address` in particular deliberately does NOT claim "you cannot issue": the chain only ever
 * cares about whichever wallet is actually connected at issuance time, never this app's own
 * record of one, so a vet with no RECORDED address might still hold a whitelisted connected
 * wallet the app simply has no way to know about. */
export function operatorStatusExplanation(status: OperatorStatus): string {
  switch (status) {
    case "whitelisted":
      return "This address is whitelisted on the clinic's clone - you can issue DogTags with it.";
    case "not-whitelisted":
      return "You are a vet/owner but this address is not whitelisted on the clinic clone - you cannot issue DogTags until the DogTag admin approves an operator request for it in the admin portal.";
    case "no-address":
      return "No wallet address is on file for you yet, so this app cannot confirm whether you can issue DogTags on chain. Record one above, or ask an owner to assign one in Practitioner profiles.";
    case "not-configured":
      return "This clinic's clone has not been set up yet (run the setup wizard in Settings), so whitelist status cannot be checked yet.";
    case "unreadable":
      return "The clinic's clone could not be reached just now, so whitelist status could not be confirmed - try again shortly.";
  }
}

export interface VetWalletBannerInput {
  status: OperatorStatus;
  recordedAddress?: string;
  connectedAddress?: string;
  isConnected: boolean;
}

export interface VetWalletBannerDecision {
  show: boolean;
  /** The recorded-address half of the banner (missing/not-whitelisted/could not verify) - every
   * status except `whitelisted`. */
  showStatusIssue: boolean;
  /** The independent "your connected wallet isn't the one on file" fact - can be true even when
   * `showStatusIssue` is false (a whitelisted recorded address, but a DIFFERENT wallet is
   * currently connected in the browser) or false when there is nothing to compare (no wallet
   * connected, or no recorded address to compare against). */
  showMismatch: boolean;
}

/**
 * WP4.7C item 3(b) - pure decision logic for `VetWalletStatusBanner`, extracted specifically so
 * "banner visibility per case" (this item's own test requirement) is unit-testable without a
 * React renderer - this codebase has no component-testing harness (every existing test is
 * API/model/logic-level; UI behavior is proven in Playwright e2e instead, per item 4). The
 * component itself is a thin wrapper that feeds this function `useAccount()`'s live values.
 *
 * Three independent triggers, not one compound condition - the banner shows if ANY hold, and
 * both facts render when both do ("both facts shown", this item's own text): a missing/non-
 * whitelisted/unreadable recorded address, OR a connected wallet that differs from the recorded
 * one (checked even when the recorded one IS whitelisted - the wrong wallet still fails on chain
 * regardless of what the recorded one would have done).
 */
export function decideVetWalletBanner({status, recordedAddress, connectedAddress, isConnected}: VetWalletBannerInput): VetWalletBannerDecision {
  const showStatusIssue = status !== "whitelisted";
  const showMismatch =
    isConnected &&
    Boolean(connectedAddress) &&
    Boolean(recordedAddress) &&
    connectedAddress!.toLowerCase() !== recordedAddress!.toLowerCase();
  return {show: showStatusIssue || showMismatch, showStatusIssue, showMismatch};
}
