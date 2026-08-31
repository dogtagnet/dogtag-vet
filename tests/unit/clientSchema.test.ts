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
});
