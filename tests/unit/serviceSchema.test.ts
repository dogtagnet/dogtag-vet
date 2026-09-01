import {describe, expect, it} from "vitest";
import {createServiceSchema} from "@/lib/schemas/service";

/**
 * WP4.5 issue 1 (calendar service dropdown): the root cause was zero services existing in the DB,
 * not a schema bug - these tests characterize createServiceSchema's existing defaults as
 * regression coverage for the UX fix (CreateAppointmentPanel's empty-state hint and ServiceForm's
 * "Bookable online" helper text both exist BECAUSE `active`/`bookableOnline` silently default the
 * way they do here).
 */
describe("createServiceSchema - defaults", () => {
  it("defaults active to true when omitted", () => {
    const parsed = createServiceSchema.safeParse({name: "Dental cleaning", durationMinutes: 45});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.active).toBe(true);
  });

  it("defaults bookableOnline to false when omitted - the hazard the ServiceForm helper text warns about", () => {
    const parsed = createServiceSchema.safeParse({name: "Dental cleaning", durationMinutes: 45});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.bookableOnline).toBe(false);
  });

  it("respects an explicit active: false rather than overriding it with the default", () => {
    const parsed = createServiceSchema.safeParse({name: "Dental cleaning", durationMinutes: 45, active: false});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.active).toBe(false);
  });

  it("respects an explicit bookableOnline: true rather than overriding it with the default", () => {
    const parsed = createServiceSchema.safeParse({name: "Dental cleaning", durationMinutes: 45, bookableOnline: true});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.bookableOnline).toBe(true);
  });

  it.each([0, -1, 1.5])("rejects a non-positive-integer durationMinutes (%s)", (durationMinutes) => {
    const parsed = createServiceSchema.safeParse({name: "Dental cleaning", durationMinutes});
    expect(parsed.success).toBe(false);
  });

  it("accepts a positive integer durationMinutes", () => {
    const parsed = createServiceSchema.safeParse({name: "Dental cleaning", durationMinutes: 45});
    expect(parsed.success).toBe(true);
  });
});
