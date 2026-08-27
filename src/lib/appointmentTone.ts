import type {AppointmentStatus} from "@/lib/models/Appointment";
import type {StatusTone} from "@/components/ui/StatusBadge";

/**
 * Single source of truth mapping the six v1-preserved internal appointment statuses onto the
 * shared status-tone palette (design-system.md) - used by both the appointments `DataTable`'s
 * `StatusBadge` cell and the calendar grid's event chips, so a status never gets a bespoke color
 * in one place and the shared tone somewhere else.
 */
export const appointmentStatusTone: Record<AppointmentStatus, StatusTone> = {
  scheduled: "info",
  confirmed: "ok",
  in_progress: "warn",
  completed: "neutral",
  cancelled: "danger",
  no_show: "danger",
};

export const appointmentStatusLabel: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export const appointmentStatuses: AppointmentStatus[] = [
  "scheduled",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
];
