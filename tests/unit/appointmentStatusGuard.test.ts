import {describe, expect, it} from "vitest";
import {availableStatusActions, isValidStatusTransition} from "@/lib/booking/appointmentStatusGuard";
import type {AppointmentStatus} from "@/lib/models/Appointment";

describe("isValidStatusTransition", () => {
  it("allows the natural forward progression", () => {
    expect(isValidStatusTransition("scheduled", "confirmed")).toBe(true);
    expect(isValidStatusTransition("scheduled", "in_progress")).toBe(true);
    expect(isValidStatusTransition("confirmed", "in_progress")).toBe(true);
    expect(isValidStatusTransition("in_progress", "completed")).toBe(true);
  });

  it("allows cancel/no-show before an appointment has started", () => {
    expect(isValidStatusTransition("scheduled", "cancelled")).toBe(true);
    expect(isValidStatusTransition("confirmed", "cancelled")).toBe(true);
    expect(isValidStatusTransition("scheduled", "no_show")).toBe(true);
    expect(isValidStatusTransition("confirmed", "no_show")).toBe(true);
  });

  it("allows cancelling an in-progress appointment, but not marking it a no-show", () => {
    expect(isValidStatusTransition("in_progress", "cancelled")).toBe(true);
    expect(isValidStatusTransition("in_progress", "no_show")).toBe(false);
  });

  it("rejects any transition out of a terminal status", () => {
    const terminal: AppointmentStatus[] = ["completed", "cancelled", "no_show"];
    const anyOther: AppointmentStatus[] = ["scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show"];
    for (const from of terminal) {
      for (const to of anyOther) {
        expect(isValidStatusTransition(from, to)).toBe(false);
      }
    }
  });

  it("rejects a same-status no-op transition (not a real action)", () => {
    expect(isValidStatusTransition("scheduled", "scheduled")).toBe(false);
  });

  it("rejects skipping backwards (e.g. confirmed back to scheduled)", () => {
    expect(isValidStatusTransition("confirmed", "scheduled")).toBe(false);
  });
});

describe("availableStatusActions", () => {
  it("offers confirm/start/cancel/no-show from scheduled, but not complete", () => {
    const actions = availableStatusActions("scheduled").map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["confirm", "start", "cancel", "no_show"]));
    expect(actions).not.toContain("complete");
  });

  it("offers nothing from any terminal status", () => {
    expect(availableStatusActions("completed")).toHaveLength(0);
    expect(availableStatusActions("cancelled")).toHaveLength(0);
    expect(availableStatusActions("no_show")).toHaveLength(0);
  });

  it("every one of the five actions is reachable from some non-terminal status", () => {
    const allActions = new Set([
      ...availableStatusActions("scheduled").map((a) => a.action),
      ...availableStatusActions("confirmed").map((a) => a.action),
      ...availableStatusActions("in_progress").map((a) => a.action),
    ]);
    expect(allActions).toEqual(new Set(["confirm", "start", "complete", "cancel", "no_show"]));
  });
});
