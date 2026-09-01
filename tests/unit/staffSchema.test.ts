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

  it("still requires at least one field - an empty patch is rejected", () => {
    const parsed = updateStaffSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("still accepts disabled alone with no role", () => {
    const parsed = updateStaffSchema.safeParse({disabled: true});
    expect(parsed.success).toBe(true);
  });
});

/** WP4.7 A3/D2/D4: the practitioner-profile fields - each one alone satisfies the "at least one
 * field" refine (extended from the original role-or-disabled-only version), and walletAddress is
 * hex-validated + lowercased at the schema layer (defense in depth alongside `Staff.ts`'s
 * mongoose-level `lowercase: true`). */
describe("updateStaffSchema - practitioner profile fields (bookable/displayName/walletAddress)", () => {
  it("bookable alone satisfies the at-least-one-field requirement", () => {
    const parsed = updateStaffSchema.safeParse({bookable: true});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.bookable).toBe(true);
  });

  it("displayName alone satisfies the at-least-one-field requirement", () => {
    const parsed = updateStaffSchema.safeParse({displayName: "Dr. Rivera"});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.displayName).toBe("Dr. Rivera");
  });

  it("rejects an empty-string displayName (would silently blank the field rather than being rejected)", () => {
    const parsed = updateStaffSchema.safeParse({displayName: ""});
    expect(parsed.success).toBe(false);
  });

  it("walletAddress alone satisfies the at-least-one-field requirement, and is lowercased", () => {
    const parsed = updateStaffSchema.safeParse({walletAddress: "0x1234567890abcdef1234567890ABCDEF12345678"});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
  });

  it("rejects a malformed walletAddress", () => {
    const parsed = updateStaffSchema.safeParse({walletAddress: "not-an-address"});
    expect(parsed.success).toBe(false);
  });

  it("accepts an explicit null walletAddress (clears a previously-recorded one)", () => {
    const parsed = updateStaffSchema.safeParse({walletAddress: null});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.walletAddress).toBeNull();
  });

  it("back-compat: a plain role/disabled-only patch still parses with the new fields absent from the output", () => {
    const parsed = updateStaffSchema.safeParse({role: "staff"});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bookable).toBeUndefined();
      expect(parsed.data.displayName).toBeUndefined();
      expect(parsed.data.walletAddress).toBeUndefined();
    }
  });
});
