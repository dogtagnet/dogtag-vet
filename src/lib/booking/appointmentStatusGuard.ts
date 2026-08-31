import type {AppointmentStatus} from "@/lib/models/Appointment";

export interface AppointmentStatusAction {
  action: "confirm" | "start" | "complete" | "cancel" | "no_show";
  label: string;
  from: AppointmentStatus[];
  to: AppointmentStatus;
}

/**
 * The appointment detail page's status action buttons (WP4.3 C6), and the single source of truth
 * for which status transitions the PATCH route accepts. `completed`/`cancelled`/`no_show` are
 * terminal - no action starts from any of them. Cancelling is only offered before an appointment
 * has actually started (`scheduled`/`confirmed`) or while it is `in_progress`; a no-show, by
 * definition, never started, so it is only offered from `scheduled`/`confirmed`. Every one of the
 * five actions is reachable starting from `scheduled` - the status every new appointment starts
 * in - so nothing here is a dead end in the UI.
 */
export const APPOINTMENT_STATUS_ACTIONS: AppointmentStatusAction[] = [
  {action: "confirm", label: "Confirm", from: ["scheduled"], to: "confirmed"},
  {action: "start", label: "Start", from: ["scheduled", "confirmed"], to: "in_progress"},
  {action: "complete", label: "Complete", from: ["in_progress"], to: "completed"},
  {action: "cancel", label: "Cancel", from: ["scheduled", "confirmed", "in_progress"], to: "cancelled"},
  {action: "no_show", label: "No-show", from: ["scheduled", "confirmed"], to: "no_show"},
];

/** The actions available from the given current status - drives which buttons the detail page
 * renders. Empty for any terminal status. */
export function availableStatusActions(current: AppointmentStatus): AppointmentStatusAction[] {
  return APPOINTMENT_STATUS_ACTIONS.filter((a) => a.from.includes(current));
}

/** Whether moving directly from `from` to `to` is one of the actions above - the PATCH route's
 * server-side guard against a direct API call requesting a transition no button ever offers (e.g.
 * `completed` back to `confirmed`, or a same-status no-op). */
export function isValidStatusTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_STATUS_ACTIONS.some((a) => a.from.includes(from) && a.to === to);
}
