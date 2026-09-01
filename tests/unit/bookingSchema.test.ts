import {describe, expect, it} from "vitest";
import {bookAppointmentRequestSchema} from "@/lib/schemas/booking";

/**
 * `bookAppointmentRequestSchema` - plans/wp4.4-mobile-booking-protocol.md section 1: the wire
 * gains ONE optional block (`mobile`), backward compatible with today's v1 shape. zod silently
 * strips unknown fields by default, so an old client (no `mobile` at all) keeps parsing exactly as
 * before - the tests below prove that explicitly rather than assuming it.
 */
const baseRequest = {
  serviceId: "svc-1",
  startAt: "2026-09-01T10:00:00.000Z",
  client: {name: "Jordan Alvarez", email: "jordan@example.com"},
};

const validWallet = {
  address: `0x${"5b".repeat(20)}`,
  signature: `0x${"11".repeat(65)}`,
  issuedAt: 1_800_000_000,
  deadline: 1_800_000_600,
};

const validLeaf = {keyPath: "credentialSubject.species", saltHex: `0x${"22".repeat(16)}`, tag: 2, value: "dog"};
const validReservedHashes = [`0x${"aa".repeat(32)}`, `0x${"bb".repeat(32)}`, `0x${"cc".repeat(32)}`];

describe("bookAppointmentRequestSchema - backward compatibility", () => {
  it("parses today's v1 shape with no mobile block at all", () => {
    const result = bookAppointmentRequestSchema.safeParse(baseRequest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mobile).toBeUndefined();
  });

  it("parses today's v1 shape with no practitionerId at all (WP4.7 D5 - absent means auto-assign/ignored)", () => {
    const result = bookAppointmentRequestSchema.safeParse(baseRequest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.practitionerId).toBeUndefined();
  });

  it("still parses (and ignores) an entirely unknown extra top-level field, per zod's default strip behavior", () => {
    const result = bookAppointmentRequestSchema.safeParse({...baseRequest, somethingFuture: "whatever"});
    expect(result.success).toBe(true);
  });
});

describe("bookAppointmentRequestSchema - mobile block", () => {
  it("accepts source-only (no wallet, no pet claim at all)", () => {
    const result = bookAppointmentRequestSchema.safeParse({...baseRequest, mobile: {source: "dogtag_app"}});
    expect(result.success).toBe(true);
  });

  it("rejects a mobile block with a source other than the one locked value", () => {
    const result = bookAppointmentRequestSchema.safeParse({...baseRequest, mobile: {source: "some_other_app"}});
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed wallet claim", () => {
    const result = bookAppointmentRequestSchema.safeParse({...baseRequest, mobile: {source: "dogtag_app", wallet: validWallet}});
    expect(result.success).toBe(true);
  });

  it("never accepts clinic/bookingHash on the wire wallet claim - the schema has no slot for them (server always derives both itself)", () => {
    const result = bookAppointmentRequestSchema.safeParse({
      ...baseRequest,
      mobile: {source: "dogtag_app", wallet: {...validWallet, clinic: "0x0000000000000000000000000000000000000000", bookingHash: `0x${"0".repeat(64)}`}},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mobile?.wallet).not.toHaveProperty("clinic");
      expect(result.data.mobile?.wallet).not.toHaveProperty("bookingHash");
    }
  });

  it("rejects a malformed wallet address", () => {
    const result = bookAppointmentRequestSchema.safeParse({...baseRequest, mobile: {source: "dogtag_app", wallet: {...validWallet, address: "not-an-address"}}});
    expect(result.success).toBe(false);
  });

  it("rejects a malformed signature", () => {
    const result = bookAppointmentRequestSchema.safeParse({...baseRequest, mobile: {source: "dogtag_app", wallet: {...validWallet, signature: "0xdeadbeef"}}});
    expect(result.success).toBe(false);
  });

  it("accepts a bare tag claim (dogTagIdDec only, no leaves)", () => {
    const result = bookAppointmentRequestSchema.safeParse({...baseRequest, mobile: {source: "dogtag_app", pet: {dogTagIdDec: "42", dogTagIdField: "42", name: "Rex"}}});
    expect(result.success).toBe(true);
  });

  it("rejects a pet claim with neither dogTagIdDec nor dogTagIdField", () => {
    const result = bookAppointmentRequestSchema.safeParse({...baseRequest, mobile: {source: "dogtag_app", pet: {name: "Rex"}}});
    expect(result.success).toBe(false);
  });

  it("accepts a full tag claim with leaves + reservedLeafHashes (Q3 level-2 verification data)", () => {
    const result = bookAppointmentRequestSchema.safeParse({
      ...baseRequest,
      mobile: {source: "dogtag_app", pet: {dogTagIdDec: "42", leaves: [validLeaf], reservedLeafHashes: validReservedHashes}},
    });
    expect(result.success).toBe(true);
  });

  it("rejects leaves without reservedLeafHashes (malformed partial verification data, not silently downgraded)", () => {
    const result = bookAppointmentRequestSchema.safeParse({
      ...baseRequest,
      mobile: {source: "dogtag_app", pet: {dogTagIdDec: "42", leaves: [validLeaf]}},
    });
    expect(result.success).toBe(false);
  });

  it("rejects reservedLeafHashes without leaves", () => {
    const result = bookAppointmentRequestSchema.safeParse({
      ...baseRequest,
      mobile: {source: "dogtag_app", pet: {dogTagIdDec: "42", reservedLeafHashes: validReservedHashes}},
    });
    expect(result.success).toBe(false);
  });

  it("rejects reservedLeafHashes with a count other than exactly 3", () => {
    const result = bookAppointmentRequestSchema.safeParse({
      ...baseRequest,
      mobile: {source: "dogtag_app", pet: {dogTagIdDec: "42", leaves: [validLeaf], reservedLeafHashes: validReservedHashes.slice(0, 2)}},
    });
    expect(result.success).toBe(false);
  });

  it("accepts both a wallet claim and a pet claim together", () => {
    const result = bookAppointmentRequestSchema.safeParse({
      ...baseRequest,
      mobile: {source: "dogtag_app", wallet: validWallet, pet: {dogTagIdDec: "42"}},
    });
    expect(result.success).toBe(true);
  });
});

/** WP4.7 D5 - the wire-level half of practitioner selection (validated against the actual Staff
 * roster server-side, in `lifecycle.ts`'s `createAppointment` - this schema only checks shape). */
describe("bookAppointmentRequestSchema - practitionerId (WP4.7 D5)", () => {
  it("accepts a practitionerId alongside the base request", () => {
    const result = bookAppointmentRequestSchema.safeParse({...baseRequest, practitionerId: "staff-uuid-123"});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.practitionerId).toBe("staff-uuid-123");
  });

  it("rejects an empty-string practitionerId (must be a real id, not a silently-ignored blank)", () => {
    const result = bookAppointmentRequestSchema.safeParse({...baseRequest, practitionerId: ""});
    expect(result.success).toBe(false);
  });

  it("practitionerId and the mobile block are independent - both can be present together", () => {
    const result = bookAppointmentRequestSchema.safeParse({
      ...baseRequest,
      practitionerId: "staff-uuid-123",
      mobile: {source: "dogtag_app"},
    });
    expect(result.success).toBe(true);
  });
});
