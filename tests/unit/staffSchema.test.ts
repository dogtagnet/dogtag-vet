import {describe, expect, it} from "vitest";
import {inviteStaffSchema, updateStaffSchema} from "@/lib/schemas/staff";

/**
 * WP4.7 A1: a third staff role, `vet` (whitelisted, app-side, to reach the DogTag issuance
 * surfaces - the actual authority is the on-chain operator whitelist, see
 * `plans/wp4.7-vet-role-practitioner-availability.md` D4). These tests pin both staff-facing
 * schemas' acceptance of it alongside the two pre-existing roles, and that an unrelated role
 * string is still rejected (the enum is closed, not accidentally loosened to any string).
 */
describe("inviteStaffSchema - role enum", () => {
  it.each(["owner", "staff", "vet"] as const)("accepts role %s", (role) => {
    const parsed = inviteStaffSchema.safeParse({email: "colleague@clinic.example", role});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.role).toBe(role);
  });

  it("rejects an unknown role string", () => {
    const parsed = inviteStaffSchema.safeParse({email: "colleague@clinic.example", role: "admin"});
    expect(parsed.success).toBe(false);
  });
});

describe("updateStaffSchema - role enum", () => {
  it.each(["owner", "staff", "vet"] as const)("accepts role %s", (role) => {
    const parsed = updateStaffSchema.safeParse({role});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.role).toBe(role);
  });

  it("rejects an unknown role string", () => {
    const parsed = updateStaffSchema.safeParse({role: "admin"});
    expect(parsed.success).toBe(false);
  });

  it("still requires role or disabled (unchanged back-compat refine)", () => {
    const parsed = updateStaffSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("still accepts disabled alone with no role", () => {
    const parsed = updateStaffSchema.safeParse({disabled: true});
    expect(parsed.success).toBe(true);
  });
});
