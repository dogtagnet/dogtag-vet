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
