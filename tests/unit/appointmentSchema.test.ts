import {describe, expect, it} from "vitest";
import {
  createAppointmentFromLocalTimeSchema,
  createAppointmentSchema,
  updateAppointmentSchema,
} from "@/lib/schemas/appointment";

const base = {startAt: 1_000, endAt: 2_000, source: "staff" as const};
const baseLocal = {localIso: "2026-01-05T09:00:00", durationMinutes: 30};

describe("createAppointmentSchema - walk-in vs tagged (WP4.3 A1/C5)", () => {
  it("accepts a walk-in payload: no clientId, both free-text names present", () => {
    const parsed = createAppointmentSchema.safeParse({...base, clientName: "Walk-in Client", petName: "Walk-in Pet"});
    expect(parsed.success).toBe(true);
  });

  it("rejects a walk-in payload missing petName", () => {
    const parsed = createAppointmentSchema.safeParse({...base, clientName: "Walk-in Client"});
    expect(parsed.success).toBe(false);
  });

  it("rejects a walk-in payload missing clientName", () => {
    const parsed = createAppointmentSchema.safeParse({...base, petName: "Walk-in Pet"});
    expect(parsed.success).toBe(false);
  });

  it("accepts a tagged payload: clientId plus at least one petId, no free-text names required", () => {
    const parsed = createAppointmentSchema.safeParse({...base, clientId: "client-1", petIds: ["pet-1", "pet-2"]});
    expect(parsed.success).toBe(true);
  });

  it("rejects a tagged payload (clientId set) with an empty petIds array", () => {
    const parsed = createAppointmentSchema.safeParse({...base, clientId: "client-1", petIds: []});
    expect(parsed.success).toBe(false);
  });

  it("rejects a tagged payload (clientId set) with petIds omitted entirely", () => {
    const parsed = createAppointmentSchema.safeParse({...base, clientId: "client-1"});
    expect(parsed.success).toBe(false);
  });
});

describe("createAppointmentFromLocalTimeSchema - walk-in vs tagged", () => {
  it("accepts a walk-in payload", () => {
    const parsed = createAppointmentFromLocalTimeSchema.safeParse({
      ...baseLocal,
      clientName: "Walk-in Client",
      petName: "Walk-in Pet",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a walk-in payload missing both names", () => {
    const parsed = createAppointmentFromLocalTimeSchema.safeParse({...baseLocal});
    expect(parsed.success).toBe(false);
  });

  it("accepts a tagged payload with no free-text names", () => {
    const parsed = createAppointmentFromLocalTimeSchema.safeParse({
      ...baseLocal,
      clientId: "client-1",
      petIds: ["pet-1"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a tagged payload with an empty petIds array", () => {
    const parsed = createAppointmentFromLocalTimeSchema.safeParse({...baseLocal, clientId: "client-1", petIds: []});
    expect(parsed.success).toBe(false);
  });
});

describe("updateAppointmentSchema (WP4.3 C6)", () => {
  it("accepts an empty patch (e.g. a no-op save)", () => {
    expect(updateAppointmentSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a status-only patch", () => {
    expect(updateAppointmentSchema.safeParse({status: "confirmed"}).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(updateAppointmentSchema.safeParse({status: "bogus"}).success).toBe(false);
  });

  it("accepts clientId: null to untag", () => {
    const parsed = updateAppointmentSchema.safeParse({clientId: null});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.clientId).toBeNull();
  });

  it("accepts clientId as a string to tag/retag", () => {
    const parsed = updateAppointmentSchema.safeParse({clientId: "client-1"});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.clientId).toBe("client-1");
  });

  it("leaves clientId undefined when the key is omitted - distinct from explicit null", () => {
    const parsed = updateAppointmentSchema.safeParse({notes: "hi"});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.clientId).toBeUndefined();
  });

  it("accepts an empty petIds array (paired with clientId: null for a full untag)", () => {
    expect(updateAppointmentSchema.safeParse({clientId: null, petIds: []}).success).toBe(true);
  });

  it("accepts a non-empty petIds array", () => {
    expect(updateAppointmentSchema.safeParse({petIds: ["pet-1", "pet-2"]}).success).toBe(true);
  });

  it("accepts a notes-only patch", () => {
    expect(updateAppointmentSchema.safeParse({notes: "Called to reschedule"}).success).toBe(true);
  });
});
