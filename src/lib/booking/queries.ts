import "server-only";
import {Appointment} from "@/lib/models/Appointment";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {AvailabilityException, AvailabilityRule, getBookingSettings} from "@/lib/models/Availability";
import type {
  AvailabilityExceptionLike,
  AvailabilityRuleLike,
  BookingSettingsLike,
  OccupiedInterval,
} from "@/lib/booking/types";

/** Every non-cancelled appointment's already-buffered occupied interval that could plausibly
 * overlap `[fromUtc, toUtc)`, for `computeAvailability`'s `existingOccupied` input. Buffers come
 * from each appointment's own service (looked up here, not stored on the appointment itself), so
 * the query window is padded by the largest configured buffer - otherwise an appointment whose
 * buffered footprint pokes into the requested range, but whose raw `startAt`/`endAt` doesn't,
 * would be missed. */
export async function loadExistingOccupiedIntervals(fromUtc: number, toUtc: number): Promise<OccupiedInterval[]> {
  const services = await Service.find({}).lean<ServiceDoc[]>();
  const bufferByServiceId = new Map(services.map((s) => [s.serviceId, {before: s.bufferBeforeMin, after: s.bufferAfterMin}]));
  const maxBufferMinutes = services.reduce((max, s) => Math.max(max, s.bufferBeforeMin, s.bufferAfterMin), 0);
  const padSeconds = (maxBufferMinutes + 5) * 60;

  const appointments = await Appointment.find({
    status: {$nin: ["cancelled", "no_show"]},
    startAt: {$lt: toUtc + padSeconds},
    endAt: {$gt: fromUtc - padSeconds},
  })
    .select("startAt endAt serviceId")
    .lean<Array<{startAt: number; endAt: number; serviceId?: string}>>();

  return appointments.map((a) => {
    const buffers = a.serviceId ? bufferByServiceId.get(a.serviceId) : undefined;
    return {
      start: a.startAt - (buffers?.before ?? 0) * 60,
      end: a.endAt + (buffers?.after ?? 0) * 60,
    };
  });
}

export interface AvailabilityConfig {
  settings: BookingSettingsLike;
  rules: AvailabilityRuleLike[];
  exceptions: AvailabilityExceptionLike[];
}

/** The clinic's whole availability configuration - small tables, always fetched in full rather
 * than filtered by date range (simpler, and cheap at this scale). */
export async function loadAvailabilityConfig(): Promise<AvailabilityConfig> {
  const [settings, rules, exceptions] = await Promise.all([
    getBookingSettings(),
    AvailabilityRule.find({}).lean<AvailabilityRuleLike[]>(),
    AvailabilityException.find({}).lean<AvailabilityExceptionLike[]>(),
  ]);
  return {settings, rules, exceptions};
}
