import type {AppointmentStatus} from "@/lib/models/Appointment";

export type PublicAppointmentStatus = "pending" | "confirmed" | "cancelled";

/**
 * Maps the six v1-preserved internal appointment statuses onto the three-state public wire
 * enum (`vet-public-api.yaml`'s `AppointmentStatusResponse`/`BookAppointmentResponse.status`).
 *
 * This build has no staff-approval step for public bookings - `POST /v1/booking/book` confirms
 * immediately (sends the confirmation email + ics right away), so `scheduled` maps to `confirmed`
 * rather than `pending`. `pending` is reserved by the wire contract for a future "awaiting staff
 * review" workflow this stage does not implement, and is never produced here.
 */
export function toPublicAppointmentStatus(status: AppointmentStatus): PublicAppointmentStatus {
  switch (status) {
    case "cancelled":
    case "no_show":
      return "cancelled";
    case "scheduled":
    case "confirmed":
    case "in_progress":
    case "completed":
      return "confirmed";
  }
}
