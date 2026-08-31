import {describe, expect, it} from "vitest";
import {createClientSchema, updateClientSchema} from "@/lib/schemas/client";

describe("createClientSchema - identification fields (WP4.3 A2)", () => {
  it("accepts a client with no identification fields at all - only name stays required", () => {
    const parsed = createClientSchema.safeParse({name: "Jane Doe"});
    expect(parsed.success).toBe(true);
  });

  it.each(["passport", "national_id", "drivers_license", "other"] as const)(
    "accepts idDocType %s paired with idDocNumber",
    (idDocType) => {
      const parsed = createClientSchema.safeParse({name: "Jane Doe", idDocType, idDocNumber: "AB123456"});
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.idDocType).toBe(idDocType);
        expect(parsed.data.idDocNumber).toBe("AB123456");
      }
    },
  );

  it("rejects an idDocType outside the enum", () => {
    const parsed = createClientSchema.safeParse({name: "Jane Doe", idDocType: "ssn"});
    expect(parsed.success).toBe(false);
  });

  it("accepts idDocNumber alone, with no idDocType - both fields are independently optional", () => {
    const parsed = createClientSchema.safeParse({name: "Jane Doe", idDocNumber: "AB123456"});
    expect(parsed.success).toBe(true);
  });

  it("trims idDocNumber", () => {
    const parsed = createClientSchema.safeParse({name: "Jane Doe", idDocNumber: "  AB123456  "});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.idDocNumber).toBe("AB123456");
  });
});

describe("updateClientSchema - identification fields", () => {
  it("allows patching only idDocType/idDocNumber, per the partial() update contract", () => {
    const parsed = updateClientSchema.safeParse({idDocType: "national_id", idDocNumber: "N-99"});
    expect(parsed.success).toBe(true);
  });

  // Round-2 fix: idDocType/idDocNumber can be SET but could never be CLEARED - an emptied field
  // in ClientForm serialized to `undefined`, which JSON.stringify drops from the body entirely, so
  // the PATCH route's key-absent-means-untouched contract left the old value in place while the UI
  // reported success. `null` is the explicit-clear signal, mirroring updateAppointmentSchema's
  // already-shipped `clientId?: string | null` tri-state (key absent = untouched, `null` =
  // cleared, a string = the new value).
  describe("nullable-to-clear (round-2 fix)", () => {
    it("accepts idDocType: null - an explicit clear, independent of idDocNumber", () => {
      const parsed = updateClientSchema.safeParse({idDocType: null});
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.idDocType).toBeNull();
    });

    it("accepts idDocNumber: null - an explicit clear, independent of idDocType", () => {
      const parsed = updateClientSchema.safeParse({idDocNumber: null});
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.idDocNumber).toBeNull();
    });

    it("accepts clearing one field while keeping the other set, in either direction", () => {
      const clearNumberKeepType = updateClientSchema.safeParse({idDocType: "passport", idDocNumber: null});
      expect(clearNumberKeepType.success).toBe(true);
      if (clearNumberKeepType.success) {
        expect(clearNumberKeepType.data.idDocType).toBe("passport");
        expect(clearNumberKeepType.data.idDocNumber).toBeNull();
      }

      const clearTypeKeepNumber = updateClientSchema.safeParse({idDocType: null, idDocNumber: "P-1"});
      expect(clearTypeKeepNumber.success).toBe(true);
      if (clearTypeKeepNumber.success) {
        expect(clearTypeKeepNumber.data.idDocType).toBeNull();
        expect(clearTypeKeepNumber.data.idDocNumber).toBe("P-1");
      }
    });

    it("still rejects an empty string for idDocNumber - null is the only way to clear, by design", () => {
      const parsed = updateClientSchema.safeParse({idDocNumber: ""});
      expect(parsed.success).toBe(false);
    });

    it("omitting both keys entirely still means untouched - not a clear", () => {
      const parsed = updateClientSchema.safeParse({name: "Jane Doe"});
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect("idDocType" in parsed.data).toBe(false);
        expect("idDocNumber" in parsed.data).toBe(false);
      }
    });
  });
});

describe("createClientSchema - null is NOT accepted (asymmetric with updateClientSchema)", () => {
  // A brand-new client has nothing to clear, and ClientForm never sends null on create (see
  // ClientForm.tsx) - createClientSchema intentionally stays exactly as strict as before.
  it("rejects idDocType: null on create", () => {
    const parsed = createClientSchema.safeParse({name: "Jane Doe", idDocType: null});
    expect(parsed.success).toBe(false);
  });

  it("rejects idDocNumber: null on create", () => {
    const parsed = createClientSchema.safeParse({name: "Jane Doe", idDocNumber: null});
    expect(parsed.success).toBe(false);
  });
});
