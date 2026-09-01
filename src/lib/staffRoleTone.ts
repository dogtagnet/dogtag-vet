import type {StaffRole} from "@/lib/models/Staff";
import type {StatusTone} from "@/components/ui/StatusBadge";

/** Single source of truth for a staff account's role badge (the `Topbar`), matching
 * `appointmentTone.ts`/`paymentTone.ts`'s pattern. */
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
