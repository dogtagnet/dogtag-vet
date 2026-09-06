import {describe, expect, it} from "vitest";
import {inviteStaffSchema, selfProfileSchema, updateStaffSchema} from "@/lib/schemas/staff";

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

  it("accepts an explicit null displayName (WP4.13 fix: this used to have no way to be cleared at all)", () => {
    const parsed = updateStaffSchema.safeParse({displayName: null});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.displayName).toBeNull();
  });

  it("back-compat: a plain role/disabled-only patch still parses with the new fields absent from the output", () => {
    const parsed = updateStaffSchema.safeParse({role: "staff"});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bookable).toBeUndefined();
      expect(parsed.data.displayName).toBeUndefined();
      expect(parsed.data.firstName).toBeUndefined();
      expect(parsed.data.lastName).toBeUndefined();
      expect(parsed.data.title).toBeUndefined();
      expect(parsed.data.accreditationNumber).toBeUndefined();
      expect(parsed.data.walletAddress).toBeUndefined();
    }
  });
});

/**
 * WP4.13 (Kenneth issue 3) - the first/last name split, title/qualification, and government
 * accreditation number. Each alone satisfies the "at least one field" refine (the hand-enumerated
 * list `updateStaffSchema` itself uses, extended rather than replaced with a generic
 * `Object.keys(v).length` check) - this is the exact property the plan calls out: "a PATCH
 * carrying only `firstName` is accepted".
 */
describe("updateStaffSchema - WP4.13 name/title/accreditation fields", () => {
  it.each(["firstName", "lastName", "title", "accreditationNumber"] as const)(
    "%s alone satisfies the at-least-one-field requirement",
    (field) => {
      const parsed = updateStaffSchema.safeParse({[field]: "value"});
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data[field]).toBe("value");
    },
  );

  it.each(["firstName", "lastName", "title", "accreditationNumber"] as const)(
    "rejects an empty-string %s (would silently blank the field rather than being rejected)",
    (field) => {
      const parsed = updateStaffSchema.safeParse({[field]: ""});
      expect(parsed.success).toBe(false);
    },
  );

  it.each(["firstName", "lastName", "title", "accreditationNumber"] as const)(
    "accepts an explicit null %s (clears a previously-recorded value)",
    (field) => {
      const parsed = updateStaffSchema.safeParse({[field]: null});
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data[field]).toBeNull();
    },
  );

  it("title has its own shorter max length (40) than the name fields (120)", () => {
    const parsed = updateStaffSchema.safeParse({title: "x".repeat(41)});
    expect(parsed.success).toBe(false);
  });

  it("accreditationNumber has its own max length (64)", () => {
    const tooLong = updateStaffSchema.safeParse({accreditationNumber: "x".repeat(65)});
    expect(tooLong.success).toBe(false);
    const atLimit = updateStaffSchema.safeParse({accreditationNumber: "x".repeat(64)});
    expect(atLimit.success).toBe(true);
  });
});

/**
 * WP4.13 item 2 - the self-service counterpart to `updateStaffSchema`'s name/title/accreditation
 * fields: a vet/owner setting THEIR OWN name/title/accreditation. `.strict()` so a `role`,
 * `bookable`, or `walletAddress` a client should never be able to send here is rejected outright,
 * same convention as `selfWalletSchema`.
 */
describe("selfProfileSchema", () => {
  it.each(["firstName", "lastName", "title", "accreditationNumber"] as const)(
    "%s alone satisfies the at-least-one-field requirement",
    (field) => {
      const parsed = selfProfileSchema.safeParse({[field]: "value"});
      expect(parsed.success).toBe(true);
    },
  );

  it("rejects an empty patch", () => {
    const parsed = selfProfileSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown key (role) outright - .strict()", () => {
    const parsed = selfProfileSchema.safeParse({firstName: "Jane", role: "owner"});
    expect(parsed.success).toBe(false);
  });

  it("rejects walletAddress - this route is name/title/accreditation only, wallet stays on the sibling /me/wallet route", () => {
    const parsed = selfProfileSchema.safeParse({firstName: "Jane", walletAddress: "0x1234567890123456789012345678901234567890"});
    expect(parsed.success).toBe(false);
  });

  it("rejects bookable - bookable stays owner-only", () => {
    const parsed = selfProfileSchema.safeParse({firstName: "Jane", bookable: true});
    expect(parsed.success).toBe(false);
  });

  it("accepts an explicit null for any field (clears it) alongside a set value for another", () => {
    const parsed = selfProfileSchema.safeParse({title: null, accreditationNumber: "USDA-1234"});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.title).toBeNull();
      expect(parsed.data.accreditationNumber).toBe("USDA-1234");
    }
  });
});
