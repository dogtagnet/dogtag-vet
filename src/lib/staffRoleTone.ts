import type {StaffRole} from "@/lib/models/Staff";
import type {StatusTone} from "@/components/ui/StatusBadge";

/** Single source of truth for a staff account's role badge (the `Topbar`), matching
 * `appointmentTone.ts`/`paymentTone.ts`'s pattern. */
export const staffRoleTone: Record<StaffRole, StatusTone> = {
  owner: "info",
  staff: "neutral",
};

export const staffRoleLabel: Record<StaffRole, string> = {
  owner: "Owner",
  staff: "Staff",
};
