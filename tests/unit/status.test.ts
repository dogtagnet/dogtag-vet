import {describe, expect, it} from "vitest";
import {toPublicAppointmentStatus} from "@/lib/booking/status";
import type {AppointmentStatus} from "@/lib/models/Appointment";

describe("toPublicAppointmentStatus", () => {
  const cases: Array<[AppointmentStatus, "pending" | "confirmed" | "cancelled"]> = [
    ["scheduled", "confirmed"],
    ["confirmed", "confirmed"],
    ["in_progress", "confirmed"],
    ["completed", "confirmed"],
    ["cancelled", "cancelled"],
    ["no_show", "cancelled"],
  ];

  it.each(cases)("maps internal status %s to public status %s", (internal, expected) => {
    expect(toPublicAppointmentStatus(internal)).toBe(expected);
  });

  it("never produces 'pending' - this build has no staff-approval workflow", () => {
    const allInternal: AppointmentStatus[] = [
      "scheduled",
      "confirmed",
      "in_progress",
      "completed",
      "cancelled",
      "no_show",
    ];
    for (const status of allInternal) {
      expect(toPublicAppointmentStatus(status)).not.toBe("pending");
    }
  });
});
