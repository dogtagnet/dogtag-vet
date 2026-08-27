import "server-only";
import {getBookingSettings} from "@/lib/models/Availability";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import type {AppointmentDoc} from "@/lib/models/Appointment";

/** Whether `POST .../cancel` would currently succeed: not already cancelled/no-show, and still
 * far enough out - this build reuses `minNoticeMinutes` (the same cutoff new bookings must
 * respect) as the cancellation cutoff too, since the spec defines no separate cancellation-policy
 * setting. */
export async function computeCancellable(appointment: AppointmentDoc, now: number): Promise<boolean> {
  if (appointment.status === "cancelled" || appointment.status === "no_show") return false;
  if (appointment.startAt <= now) return false;
  const settings = await getBookingSettings();
  return appointment.startAt >= now + settings.minNoticeMinutes * 60;
}

export async function loadServiceName(serviceId: string | undefined): Promise<string> {
  if (!serviceId) return "Appointment";
  const service = await Service.findOne({serviceId}).lean<ServiceDoc>();
  return service?.name ?? "Appointment";
}
