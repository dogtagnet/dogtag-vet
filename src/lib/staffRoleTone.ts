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
 * the public availability response's `practitioners[].name` (D5) - `displayName` when set (D2),
 * else the email's local part (everything before `@`) as a reasonable default rather than showing
 * a full email address (or nothing) on a public-facing slot button. Pure and reused everywhere a
 * practitioner needs a human-readable name so this fallback rule lives in exactly one place.
 */
export function practitionerDisplayName(staff: Pick<StaffDoc, "displayName" | "email">): string {
  if (staff.displayName?.trim()) return staff.displayName.trim();
  return staff.email.split("@")[0] ?? staff.email;
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
      return "You are a vet/owner but this address is not whitelisted on the clinic clone - you cannot issue DogTags until an owner adds it under Issuance operators.";
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
